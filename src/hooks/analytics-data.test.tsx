// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useAnalyticsData } from "./use-analytics-data"
import { useLiveVisitors } from "./use-live-visitors"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
describe("analytics request state", () => {
  it("hides old website figures and rejects late results after switching websites", async () => {
    let delayed: (value: unknown) => void = () => {}
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ visits: 100 }),
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            delayed = resolve
          })
      )
      .mockResolvedValueOnce({ ok: false })
    vi.stubGlobal("fetch", fetch)
    const { result, rerender } = renderHook(
      ({ url }) => useAnalyticsData<{ visits: number }>(url),
      { initialProps: { url: "/site-a" } }
    )
    await waitFor(() => expect(result.current.data?.visits).toBe(100))
    rerender({ url: "/site-b" })
    expect(result.current.data).toBeUndefined()
    rerender({ url: "/site-c" })
    await waitFor(() => expect(result.current.error).toBeDefined())
    await act(async () => {
      delayed({ ok: true, json: () => Promise.resolve({ visits: 200 }) })
      await Promise.resolve()
    })
    expect(result.current.data).toBeUndefined()
    expect(result.current.error).toBeDefined()
  })
  it("supports retry after a failed request", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ visits: 10 }),
        })
    )
    const { result } = renderHook(() =>
      useAnalyticsData<{ visits: number }>("/site")
    )
    await waitFor(() => expect(result.current.error).toBeDefined())
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.data?.visits).toBe(10))
    expect(result.current.error).toBeUndefined()
  })
})

class Socket {
  static instances: Array<Socket> = []
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  constructor(_url: string) {
    Socket.instances.push(this)
  }
  close() {
    this.onclose?.()
  }
  message(count: number) {
    this.onmessage?.({ data: JSON.stringify({ count, locations: [] }) })
  }
}
describe("live activity freshness", () => {
  it("clears activity immediately on disconnect and recovers on a new valid update", () => {
    vi.useFakeTimers()
    Socket.instances = []
    vi.stubGlobal("WebSocket", Socket)
    const { result } = renderHook(() => useLiveVisitors("site"))
    act(() => Socket.instances[0].message(5))
    expect(result.current.count).toBe(5)
    act(() => Socket.instances[0].close())
    expect(result.current.count).toBeNull()
    expect(result.current.unavailable).toBe(true)
    act(() => vi.advanceTimersByTime(5000))
    act(() => Socket.instances[1].message(1))
    expect(result.current.count).toBe(1)
    expect(result.current.unavailable).toBe(false)
  })
  it("expires silent connections and ignores messages belonging to a previous website", () => {
    vi.useFakeTimers()
    Socket.instances = []
    vi.stubGlobal("WebSocket", Socket)
    const { result, rerender } = renderHook(
      ({ site }) => useLiveVisitors(site),
      { initialProps: { site: "a" } }
    )
    act(() => Socket.instances[0].message(5))
    rerender({ site: "b" })
    act(() => Socket.instances[0].message(99))
    expect(result.current.count).toBeNull()
    act(() => Socket.instances[1].message(2))
    act(() => vi.advanceTimersByTime(90000))
    expect(result.current.count).toBeNull()
    expect(result.current.unavailable).toBe(true)
  })
})
