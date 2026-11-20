export function formatCompactNumber(n: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n)
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
