// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { usePublicRealtime } from "./use-public-realtime"

const locations = [{ latitude: 53.3, longitude: -6.2, count: 2 }]
const fetchMock = vi.fn<typeof fetch>()
const reply = (status: number, data: unknown = { count: 3, locations: [] }) =>
  new Response(JSON.stringify(data), { status })
async function advance(milliseconds = 20_000) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds))
}

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock.mockReset().mockResolvedValue(reply(200))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("public live updates", () => {
  it.each([500, 503, 429])(
    "recovers after a temporary HTTP %s error",
    async (status) => {
      fetchMock.mockResolvedValueOnce(reply(status))
      const { result } = renderHook(() =>
        usePublicRealtime("fixture", 2, locations)
      )
      await advance()
      expect(result.current).toEqual({ count: 2, locations, unavailable: true })
      await advance()
      expect(result.current).toEqual({
        count: 3,
        locations: [],
        unavailable: false,
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
  )

  it("recovers after network errors and invalid responses", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Network unavailable"))
      .mockResolvedValueOnce(reply(200, { count: "invalid" }))
    const { result } = renderHook(() =>
      usePublicRealtime("fixture", 2, locations)
    )
    await advance()
    expect(result.current.unavailable).toBe(true)
    await advance()
    expect(result.current).toEqual({ count: 2, locations, unavailable: true })
    await advance()
    expect(result.current.unavailable).toBe(false)
  })

  it.each([404, 410])(
    "clears live data and stops when sharing returns HTTP %s",
    async (status) => {
      fetchMock.mockResolvedValueOnce(reply(status))
      const { result } = renderHook(() =>
        usePublicRealtime("fixture", 2, locations)
      )
      await advance()
      expect(result.current).toEqual({
        count: undefined,
        locations: undefined,
        unavailable: false,
      })
      await advance(60_000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it("removes locations when globe sharing is withdrawn but keeps live counts", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { count: 1 }))
    const { result } = renderHook(() =>
      usePublicRealtime("fixture", 2, locations)
    )
    await advance()
    expect(result.current).toEqual({
      count: 1,
      locations: undefined,
      unavailable: false,
    })
    await advance()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("times out hung requests and retries without overlapping them", async () => {
    fetchMock.mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          )
        })
    )
    const { result } = renderHook(() =>
      usePublicRealtime("fixture", 2, locations)
    )
    await advance()
    await advance(9_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await advance(1_000)
    expect(result.current.unavailable).toBe(true)
    await advance()
    expect(result.current).toEqual({
      count: 3,
      locations: [],
      unavailable: false,
    })
  })

  it("ignores old responses after navigating to another public view", async () => {
    let resolveOld!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    const { result, rerender } = renderHook(
      ({ slug, count }) => usePublicRealtime(slug, count, locations),
      {
        initialProps: { slug: "first", count: 2 },
      }
    )
    await advance()
    const oldSignal = fetchMock.mock.calls[0][1]?.signal
    rerender({ slug: "second", count: 7 })
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => {
      resolveOld(reply(200, { count: 99, locations: [] }))
      await Promise.resolve()
    })
    expect(result.current.count).toBe(7)
    await advance()
    expect(fetchMock.mock.calls[1][0]).toBe("/api/public/second/realtime")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does not poll when live counts are not shared and aborts on unmount", async () => {
    const withoutLive = renderHook(() =>
      usePublicRealtime("fixture", undefined, undefined)
    )
    await advance()
    expect(fetchMock).not.toHaveBeenCalled()
    withoutLive.unmount()
    fetchMock.mockImplementationOnce(() => new Promise(() => {}))
    const { unmount } = renderHook(() =>
      usePublicRealtime("fixture", 2, locations)
    )
    await advance()
    const signal = fetchMock.mock.calls[0][1]?.signal
    unmount()
    expect(signal?.aborted).toBe(true)
    await advance(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
