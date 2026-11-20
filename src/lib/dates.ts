/**
 * Date-range helpers, timezone-aware (per-site `timezone`, §5).
 *
 * D1/SQLite has no timezone-aware date functions. Local day boundaries are
 * resolved with Intl, including offset changes around midnight.
 */

export type RangeKey =
  "today" | "yesterday" | "7d" | "30d" | "6m" | "1y" | "custom"

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0)
    return true
  } catch {
    return false
  }
}

export function isRangeKey(value: string | null): value is RangeKey {
  return (
    value === "today" ||
    value === "yesterday" ||
    value === "7d" ||
    value === "30d" ||
    value === "6m" ||
    value === "1y" ||
    value === "custom"
  )
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>()
const offsetFormatters = new Map<string, Intl.DateTimeFormat>()
function formatter(
  cache: Map<string, Intl.DateTimeFormat>,
  timezone: string,
  options: Intl.DateTimeFormatOptions
) {
  let result = cache.get(timezone)
  if (!result) {
    result = new Intl.DateTimeFormat("en-CA", {
      ...options,
      timeZone: timezone,
    })
    if (cache.size >= 64) cache.clear()
    cache.set(timezone, result)
  }
  return result
}

/** Formats a Date as `YYYY-MM-DD` in the given IANA timezone. */
export function formatDateInTz(date: Date, timezone: string): string {
  const parts = formatter(dateFormatters, timezone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value
  return `${map.year}-${map.month}-${map.day}`
}

export function todayInTz(timezone: string): string {
  return formatDateInTz(new Date(), timezone)
}

/** Minutes to add to a UTC timestamp to get local wall-clock time. */
function getTimezoneOffsetMinutes(timezone: string, date: Date): number {
  const dtf = formatter(offsetFormatters, timezone, {
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const parts = dtf.formatToParts(date)
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  )
  return (asUtc - date.getTime()) / 60_000
}

/** UTC epoch ms for local midnight of `dateStr` (YYYY-MM-DD) in `timezone`. */
export function startOfDayUtcMs(dateStr: string, timezone: string): number {
  const guessUtcMs = Date.parse(`${dateStr}T00:00:00Z`)
  let instant = guessUtcMs
  let latest = instant
  for (let attempt = 0; attempt < 4; attempt++) {
    const next =
      guessUtcMs -
      getTimezoneOffsetMinutes(timezone, new Date(instant)) * 60_000
    latest = Math.max(latest, next)
    if (next === instant) break
    instant = next
    // A skipped midnight oscillates between the adjacent offsets. Its day
    // starts at the later candidate, when the new local date first exists.
    if (attempt === 3) instant = latest
  }
  if (formatDateInTz(new Date(instant - 1), timezone) >= dateStr) {
    // Midnight can occur twice when an offset moves backward. Find its first occurrence.
    let low = instant - 36 * 3600_000
    let high = instant
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2)
      if (formatDateInTz(new Date(middle), timezone) < dateStr) low = middle
      else high = middle
    }
    return high
  }
  return instant
}

/** Inclusive list of `YYYY-MM-DD` date strings from `fromDate` to `toDate`. */
export function dateRangeList(fromDate: string, toDate: string): Array<string> {
  const out: Array<string> = []
  const d = new Date(`${fromDate}T00:00:00Z`)
  const end = new Date(`${toDate}T00:00:00Z`)
  while (d.getTime() <= end.getTime()) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

export interface ResolvedRange {
  /** First day of the range, inclusive, `YYYY-MM-DD` in site tz. */
  fromDate: string
  /** Last day of the range, inclusive, `YYYY-MM-DD` in site tz. */
  toDate: string
  /** "Today" in the site's timezone. */
  today: string
}

const RANGE_DAYS: Record<
  Exclude<RangeKey, "custom" | "today" | "yesterday">,
  number
> = {
  "7d": 6,
  "30d": 29,
  "6m": 182,
  "1y": 364,
}

const MAX_CUSTOM_RANGE_DAYS = 1100

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const time = Date.parse(`${value}T00:00:00Z`)
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  )
}

export function resolveRange(
  range: RangeKey,
  timezone: string,
  customFrom?: string | null,
  customTo?: string | null
): ResolvedRange {
  const today = todayInTz(timezone)

  if (range === "custom") {
    // Unchecked dates could request an unbounded number of days.
    if (
      customFrom &&
      customTo &&
      isCalendarDate(customFrom) &&
      isCalendarDate(customTo) &&
      customFrom <= customTo &&
      customFrom <= today &&
      customTo <= shiftDate(customFrom, MAX_CUSTOM_RANGE_DAYS - 1)
    ) {
      return {
        fromDate: customFrom,
        toDate: customTo < today ? customTo : today,
        today,
      }
    }
    return { fromDate: today, toDate: today, today }
  }

  if (range === "today") {
    return { fromDate: today, toDate: today, today }
  }

  if (range === "yesterday") {
    const yesterday = shiftDate(today, -1)
    return { fromDate: yesterday, toDate: yesterday, today }
  }

  return {
    fromDate: shiftDate(today, -RANGE_DAYS[range]),
    toDate: today,
    today,
  }
}

/** Moves a `YYYY-MM-DD` calendar date by whole days. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface ComparisonRange {
  resolved: ResolvedRange
  /**
   * Exclusive end of the comparison, when the selected range is still in
   * progress. The earlier period then stops at the same point in its last day.
   */
  untilSec?: number
}

/**
 * The equally long period immediately before `range`. A range that includes
 * today is compared to date: today so far against yesterday up to the same
 * time, and the last 7 days against the 7 before them up to the same time.
 */
export function previousRange(
  range: ResolvedRange,
  timezone: string,
  nowMs = Date.now()
): ComparisonRange {
  const days = dateRangeList(range.fromDate, range.toDate).length
  const resolved = {
    fromDate: shiftDate(range.fromDate, -days),
    toDate: shiftDate(range.toDate, -days),
    today: range.today,
  }
  if (range.toDate < range.today) return { resolved }
  const elapsedMs = Math.max(0, nowMs - startOfDayUtcMs(range.today, timezone))
  const lastDayStart = startOfDayUtcMs(resolved.toDate, timezone)
  const lastDayEnd = startOfDayUtcMs(shiftDate(resolved.toDate, 1), timezone)
  return {
    resolved,
    untilSec: Math.floor(Math.min(lastDayEnd, lastDayStart + elapsedMs) / 1000),
  }
}
