export function formatCompactNumber(n: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n)
}

const countryNames = new Intl.DisplayNames(["en"], { type: "region" })

/** A country's English name, or the code as recorded when Intl doesn't know it. */
export function formatCountry(code: string): string {
  try {
    return countryNames.of(code) ?? code
  } catch {
    return code
  }
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, "0")}`
}

/** Lists, filter chips and payment rows name a traffic source the same way. */
export function formatReferrer(domain: string): string {
  return domain === "(direct)"
    ? "Direct"
    : domain === "(unknown)"
      ? "Unknown"
      : domain
}

export function formatCampaign(
  source: string,
  medium: string,
  campaign: string
): string {
  const channel = [source, medium].filter(Boolean).join(" / ")
  if (campaign && channel) return `${campaign} · ${channel}`
  return campaign || channel
}

export function formatDeviceType(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`
}

export type ComparableRange = "today" | "yesterday" | "7d" | "30d" | "6m" | "1y"

const COMPARED_WITH: Record<ComparableRange, string> = {
  today: "yesterday",
  yesterday: "the day before",
  "7d": "the previous 7 days",
  "30d": "the previous 30 days",
  "6m": "the previous 6 months",
  "1y": "the previous 12 months",
}

/**
 * Says in plain words what a change figure is measured against, as short
 * lines: the period, its dates, and whether it stops at the current time.
 */
export function describeComparison(
  range: ComparableRange,
  previous: {
    range: { fromDate: string; toDate: string }
    untilSec?: number
  }
): Array<string> {
  const { fromDate, toDate } = previous.range
  // A period that crosses a year boundary is unreadable without its years.
  const withYear = fromDate.slice(0, 4) !== toDate.slice(0, 4)
  const day = (date: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" as const } : {}),
    }).format(new Date(`${date}T00:00:00Z`))
  return [
    `Compared with ${COMPARED_WITH[range]}`,
    fromDate === toDate ? day(fromDate) : `${day(fromDate)} to ${day(toDate)}`,
    ...(previous.untilSec === undefined ? [] : ["Up to the same time of day"]),
  ]
}
