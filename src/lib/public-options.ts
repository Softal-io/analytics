export const publicMetrics = [
  "visitors",
  "visits",
  "pageviews",
  "bounceRate",
  "avgDurationSeconds",
] as const
export const publicSections = [
  "chart",
  "pages",
  "referrers",
  "outboundLinks",
  "campaigns",
  "browsers",
  "operatingSystems",
  "deviceTypes",
  "countries",
  "regions",
  "cities",
  "events",
  "realtime",
  "realtimeGlobe",
] as const
export type PublicMetric = (typeof publicMetrics)[number]
export type PublicSection = (typeof publicSections)[number]
export const metricLabels: Record<PublicMetric, string> = {
  visitors: "Visitors",
  visits: "Visits",
  pageviews: "Pageviews",
  bounceRate: "Bounce rate",
  avgDurationSeconds: "Average duration",
}
export const sectionLabels: Record<PublicSection, string> = {
  chart: "Traffic chart",
  pages: "Top pages",
  referrers: "Referrers and recorded URLs",
  outboundLinks: "Outbound links",
  campaigns: "UTM campaigns and recorded URLs",
  browsers: "Browsers",
  operatingSystems: "Operating systems",
  deviceTypes: "Device types",
  countries: "Countries",
  regions: "Regions",
  cities: "Cities",
  events: "Custom events",
  realtime: "Visitors active in the last 5 minutes",
  realtimeGlobe: "Recent activity globe",
}
export function canShareRealtimeGlobe(sections: ReadonlyArray<PublicSection>) {
  return sections.includes("realtime") && sections.includes("cities")
}

export interface PublicViewSettings {
  slug: string
  enabled: boolean
  metrics: Array<PublicMetric>
  sections: Array<PublicSection>
}
