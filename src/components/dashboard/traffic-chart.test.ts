import { describe, expect, it } from "vitest"
import { chartTimestamp } from "./traffic-chart"

describe("website timezone chart formatting", () => {
  it("uses the website date in labels and hover details, including across calendar boundaries", () => {
    const ts = Date.parse("2026-09-01T00:00:00Z")
    expect(chartTimestamp(ts, "America/Los_Angeles")).toBe("31 Aug")
    expect(chartTimestamp(ts, "America/Los_Angeles", false, true)).toContain(
      "31 Aug 2026"
    )
    expect(chartTimestamp(ts, "Europe/Dublin", false, true)).toContain(
      "01 Sept 2026"
    )
  })
  it("distinguishes both occurrences of an hour when daylight saving ends", () => {
    const first = chartTimestamp(
      Date.parse("2026-10-25T00:30:00Z"),
      "Europe/Dublin",
      true,
      true
    )
    const second = chartTimestamp(
      Date.parse("2026-10-25T01:30:00Z"),
      "Europe/Dublin",
      true,
      true
    )
    expect(first).toContain("01:30 GMT+1")
    expect(second).toContain("01:30 GMT")
    expect(first).not.toBe(second)
  })
})
