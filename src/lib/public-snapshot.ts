import type { PublicMetric, PublicSection } from "@/lib/public-options"

export interface PublicList {
  rows: Array<{ label: string; count: number }>
  total: number
}
export interface PublicSnapshot {
  site: { name: string; domain: string }
  range: { fromDate: string; toDate: string }
  metrics: Partial<Record<PublicMetric, number>>
  sections: Partial<Record<PublicSection, PublicList>>
  chart?: Array<{ timestamp: number; visitors: number; pageviews: number }>
  realtime?: number
}

/** Copy selected numbers explicitly; never serialize an internal summary. */
export function selectPublicMetrics(
  selected: Array<PublicMetric>,
  summary: Record<PublicMetric, number>
) {
  const metrics: Partial<Record<PublicMetric, number>> = {}
  for (const key of selected) metrics[key] = summary[key]
  return metrics
}

/** Geography uses only the selected granularity, even if a query has extra columns. */
export function publicLocationLabel(
  section: "countries" | "regions" | "cities",
  row: { country: string; region: string; city: string }
) {
  const country = /^[A-Z]{2}$/.test(row.country)
    ? (new Intl.DisplayNames(["en"], { type: "region" }).of(row.country) ??
      row.country)
    : row.country
  if (section === "cities")
    return [row.city, country].filter(Boolean).join(", ")
  if (section === "regions")
    return [row.region, country].filter(Boolean).join(", ")
  return country || "Unknown"
}
