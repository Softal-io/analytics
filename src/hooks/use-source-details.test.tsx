// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useSourceDetails } from "./use-source-details"

const initial = { utmSource: "Presentify", links: [], linkCount: 0 }
const key = JSON.stringify(["Presentify", "", ""])
const details = {
  ...initial,
  links: [
    { url: "https://presentifyapp.com/offers", kind: "referrer", visits: 3 },
  ],
  linkCount: 1,
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("source URL loading", () => {
  it("defers fetching, collapses concurrent opens, and reuses results", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve(details) })
    vi.stubGlobal("fetch", fetch)
    const first = renderHook(() => useSourceDetails("/concurrent?range=7d"))
    const second = renderHook(() => useSourceDetails("/concurrent?range=7d"))
    expect(fetch).not.toHaveBeenCalled()
    await act(async () => {
      await Promise.all([
        first.result.current.load(key, "utm"),
        second.result.current.load(key, "utm"),
      ])
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(second.result.current.get(key, "utm", initial).details).toEqual(
      details
    )
    await act(() => first.result.current.load(key, "utm"))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("lets the visitor retry an invalid response without breaking the dashboard", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ broken: true }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(details) })
    vi.stubGlobal("fetch", fetch)
    const hook = renderHook(() => useSourceDetails("/retry?range=7d"))
    await act(() => hook.result.current.load(key, "utm"))
    expect(hook.result.current.get(key, "utm", initial).error).toBe(
      "Could not load URL details."
    )
    await act(() => hook.result.current.load(key, "utm", true))
    expect(hook.result.current.get(key, "utm", initial).error).toBeUndefined()
    expect(hook.result.current.get(key, "utm", initial).details).toEqual(
      details
    )
  })

  it("does not extend a server-cached ranking beyond its five-minute freshness window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"))
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ...details,
          updatedAt: Math.floor(Date.now() / 1000) - 240,
        }),
    })
    vi.stubGlobal("fetch", fetch)
    const hook = renderHook(() => useSourceDetails("/freshness?range=7d"))
    await act(() => hook.result.current.load(key, "utm"))
    vi.setSystemTime(new Date("2026-10-02T12:01:01Z"))
    await act(() => hook.result.current.load(key, "utm"))
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
