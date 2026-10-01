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
  referrers: "Referrers",
  outboundLinks: "Outbound links",
  campaigns: "UTM campaigns",
  browsers: "Browsers",
  operatingSystems: "Operating systems",
  deviceTypes: "Device types",
  countries: "Countries",
  regions: "Regions",
  cities: "Cities",
  events: "Custom events",
  realtime: "Live visitor count",
}
export interface PublicViewSettings {
  slug: string
  enabled: boolean
  metrics: Array<PublicMetric>
  sections: Array<PublicSection>
}
