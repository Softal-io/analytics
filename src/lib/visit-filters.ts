import { sql } from "drizzle-orm"
import { campaignKey, hasVisitFilters } from "./visit-filter-schema"
import type { SQL } from "drizzle-orm"
import type { VisitFilters } from "./visit-filter-schema"

/**
 * Conditions on a visits row named `v`. Lookups that match few rows are
 * uncorrelated, and per-visit checks use an index on the visit.
 */
function conditions(siteId: string, filters: VisitFilters, v: SQL): Array<SQL> {
  const out: Array<SQL> = []
  if (filters.page)
    out.push(
      sql`EXISTS (SELECT 1 FROM pages fp WHERE fp.visit_id = ${v}.id AND fp.path = ${filters.page})`
    )
  if (filters.entry) out.push(sql`${v}.entry_page = ${filters.entry}`)
  if (filters.exit) out.push(sql`${v}.exit_page = ${filters.exit}`)
  if (filters.referrer)
    out.push(
      sql`${v}.source_id IN (SELECT id FROM sources WHERE site_id = ${siteId} AND referrer_domain = ${filters.referrer})`
    )
  if (filters.utm) {
    const [source, medium, campaign] = campaignKey.parse(
      JSON.parse(filters.utm)
    )
    // Older rows store an absent campaign value as NULL rather than ''.
    out.push(
      sql`${v}.source_id IN (SELECT id FROM sources WHERE site_id = ${siteId}
        AND COALESCE(utm_source, '') = ${source} AND COALESCE(utm_medium, '') = ${medium}
        AND COALESCE(utm_campaign, '') = ${campaign})`
    )
  }
  if (filters.browser || filters.os || filters.device) {
    const device = [
      filters.browser ? sql`browser = ${filters.browser}` : undefined,
      filters.os ? sql`os = ${filters.os}` : undefined,
      filters.device ? sql`device_type = ${filters.device}` : undefined,
    ].filter((part): part is SQL => part !== undefined)
    out.push(
      sql`${v}.device_id IN (SELECT id FROM devices WHERE ${sql.join(device, sql` AND `)})`
    )
  }
  if (filters.country || filters.region || filters.city) {
    const location = [
      filters.country ? sql`country = ${filters.country}` : undefined,
      filters.region ? sql`region = ${filters.region}` : undefined,
      filters.city ? sql`city = ${filters.city}` : undefined,
    ].filter((part): part is SQL => part !== undefined)
    out.push(
      sql`${v}.location_id IN (SELECT id FROM locations WHERE ${sql.join(location, sql` AND `)})`
    )
  }
  if (filters.link)
    // A click belongs to the visit that was active for its visitor at that time.
    out.push(
      sql`EXISTS (SELECT 1 FROM outbound_links fo WHERE fo.site_id = ${siteId}
        AND fo.timestamp >= ${v}.started_at AND fo.timestamp <= ${v}.ended_at
        AND fo.visitor_id = ${v}.visitor_id AND fo.url = ${filters.link})`
    )
  if (filters.event)
    out.push(
      sql`EXISTS (SELECT 1 FROM events fe WHERE fe.visit_id = ${v}.id AND fe.name = ${filters.event})`
    )
  if (filters.paid)
    // Payments reference a page, which follows its visit through session merges.
    out.push(
      sql`${v}.id IN (SELECT fpp.visit_id FROM payments fpay JOIN pages fpp ON fpp.id = fpay.page_id
        WHERE fpay.site_id = ${siteId} AND fpay.status != 'refunded')`
    )
  return out
}

/** Filter for a query whose visits table (or alias) is named `table`. */
export function visitsFilter(
  siteId: string,
  filters: VisitFilters | undefined,
  table = "visits"
): SQL | undefined {
  if (!filters || !hasVisitFilters(filters)) return undefined
  const parts = conditions(siteId, filters, sql.raw(`"${table}"`))
  return parts.length ? sql`(${sql.join(parts, sql` AND `)})` : undefined
}

/** Filter for rows that carry a `visit_id` column: pages and events. */
export function visitRowsFilter(
  siteId: string,
  filters: VisitFilters | undefined,
  table: "pages" | "events" | "p"
): SQL | undefined {
  const filter = visitsFilter(siteId, filters, "fv")
  return filter
    ? sql`EXISTS (SELECT 1 FROM visits fv WHERE fv.id = ${sql.raw(`"${table}"`)}.visit_id AND ${filter})`
    : undefined
}

/** Filter for outbound clicks, matched to the visit active at the click. */
export function outboundFilter(
  siteId: string,
  filters: VisitFilters | undefined
): SQL | undefined {
  const filter = visitsFilter(siteId, filters, "fv")
  return filter
    ? sql`EXISTS (SELECT 1 FROM visits fv WHERE fv.visitor_id = "outbound_links".visitor_id
        AND fv.started_at <= "outbound_links".timestamp AND fv.ended_at >= "outbound_links".timestamp
        AND fv.site_id = ${siteId} AND ${filter})`
    : undefined
}
