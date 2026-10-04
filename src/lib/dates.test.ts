import { describe, expect, it } from "vitest"
import { formatDateInTz, startOfDayUtcMs } from "./dates"

describe("local day boundaries", () => {
  it.each([
    ["Australia/Sydney", "2026-10-04"],
    ["Pacific/Chatham", "2026-09-27"],
    ["America/Santiago", "2026-09-06"],
    ["Asia/Amman", "2021-10-29"],
    ["Africa/Cairo", "2026-10-30"],
    ["Europe/Dublin", "2026-10-25"],
    ["Asia/Kolkata", "2024-02-29"],
  ])(
    "finds the first instant of %s's %s, including midnight offset changes",
    (timezone, date) => {
      const start = startOfDayUtcMs(date, timezone)
      expect(formatDateInTz(new Date(start), timezone)).toBe(date)
      expect(formatDateInTz(new Date(start - 1), timezone)).not.toBe(date)
    }
  )
})
