import { env } from "cloudflare:workers"
import { and, eq } from "drizzle-orm"
import { loadSourceUrlDetails } from "./source-url-details"
import type { RangeKey } from "@/lib/dates"
import type {
  DeviceDimension,
  LocationDimension,
  SourceDimension,
} from "@/lib/top-lists"
import type { PublicSnapshot } from "@/lib/public-snapshot"
import type { SourceDetailsRequest } from "./source-url-details"
import { db } from "@/db"
import { sitePublicViews, sites } from "@/db/schema"
import { getReportingSlices } from "@/lib/reporting-slices"
import { resolveRange } from "@/lib/dates"
import { computeSummary } from "@/lib/summary"
import { computeTimeseries } from "@/lib/timeseries"
import {
  computeEventList,
  computeTopDevices,
  computeTopLocations,
  computeTopPages,
  computeTopSources,
} from "@/lib/top-lists"
import { publicLocationLabel, selectPublicMetrics } from "@/lib/public-snapshot"
import { canShareRealtimeGlobe } from "@/lib/public-options"

export async function loadPublicSourceDetails(
  slug: string,
  range: Exclude<RangeKey, "custom">,
  input: SourceDetailsRequest
) {
  const view = await loadPublicView(slug)
  const section = input.view === "utm" ? "campaigns" : "referrers"
  if (!view?.settings.sections.includes(section)) return undefined
  return loadSourceUrlDetails(
    view.site,
    resolveRange(range, view.site.timezone),
    input
  )
}

export async function loadPublicView(slug: string) {
  return db
    .select({ site: sites, settings: sitePublicViews })
    .from(sitePublicViews)
    .innerJoin(sites, eq(sites.id, sitePublicViews.siteId))
    .where(
      and(eq(sitePublicViews.slug, slug), eq(sitePublicViews.enabled, true))
    )
    .get()
}

export async function loadPublicRealtime(
  view: NonNullable<Awaited<ReturnType<typeof loadPublicView>>>
) {
  const visitors = env.LIVE_VISITORS.get(
    env.LIVE_VISITORS.idFromName(view.site.id)
  )
  const sharesLocations =
    view.settings.sections.includes("realtimeGlobe") &&
    canShareRealtimeGlobe(view.settings.sections)
  if (!sharesLocations) return { count: await visitors.count() }
  const { count, locations } = await visitors.snapshot()
  return { count, locations }
}

export async function loadPublicSnapshot(
  slug: string,
  range: Exclude<RangeKey, "custom">
): Promise<PublicSnapshot | null> {
  const view = await loadPublicView(slug)
  if (!view) return null
  const { site, settings } = view
  const resolved = resolveRange(range, site.timezone)
  const reporting = await getReportingSlices(site, resolved)
  const snapshot: PublicSnapshot = {
    sourceDetailsUrl: `/api/public/${encodeURIComponent(slug)}/source-details?range=${range}`,
    site: { name: site.name, domain: site.domain, timezone: site.timezone },
    range: { fromDate: resolved.fromDate, toDate: resolved.toDate },
    metrics: {},
    sections: {},
  }
  const queries: Array<Promise<void>> = []
  if (settings.metrics.length)
    queries.push(
      computeSummary(site, resolved, reporting).then((summary) => {
        snapshot.metrics = selectPublicMetrics(settings.metrics, summary)
      })
    )
  for (const section of settings.sections) {
    if (section === "chart") {
      queries.push(
        computeTimeseries(site, resolved, reporting).then((points) => {
          snapshot.chart = points.map(({ timestamp, visitors, pageviews }) => ({
            timestamp,
            visitors,
            pageviews,
          }))
        })
      )
    } else if (section === "realtime") {
      queries.push(
        loadPublicRealtime(view).then(({ count, locations }) => {
          snapshot.realtime = count
          if (locations !== undefined) snapshot.realtimeLocations = locations
        })
      )
    } else if (section === "pages") {
      queries.push(
        computeTopPages(site, resolved, "top", 10, reporting).then((list) => {
          snapshot.sections.pages = {
            total: list.total,
            rows: list.rows.map((row) => ({
              label: row.path,
              count: row.count,
            })),
          }
        })
      )
    } else if (section === "events") {
      queries.push(
        computeEventList(site, resolved, 10, reporting).then((list) => {
          snapshot.sections.events = {
            total: list.total,
            rows: list.rows.map(({ name, count }) => ({ label: name, count })),
          }
        })
      )
    } else if (
      section === "referrers" ||
      section === "outboundLinks" ||
      section === "campaigns"
    ) {
      const dimension: SourceDimension =
        section === "referrers"
          ? "referrer"
          : section === "outboundLinks"
            ? "links"
            : "utm"
      queries.push(
        computeTopSources(site, resolved, dimension, 10, reporting).then(
          (list) => {
            snapshot.sections[section] = {
              total: list.total,
              rows: list.rows.map(({ key, label, visits, details }) => ({
                ...(section !== "outboundLinks" ? { key } : {}),
                label,
                count: visits,
                ...(section === "outboundLinks" ? { url: key } : {}),
                ...(details ? { details } : {}),
              })),
            }
          }
        )
      )
    } else if (
      section === "browsers" ||
      section === "operatingSystems" ||
      section === "deviceTypes"
    ) {
      const dimension: DeviceDimension =
        section === "browsers"
          ? "browser"
          : section === "operatingSystems"
            ? "os"
            : "device"
      queries.push(
        computeTopDevices(site, resolved, dimension, 10, reporting).then(
          (list) => {
            snapshot.sections[section] = {
              total: list.total,
              rows: list.rows.map(({ value, visits }) => ({
                label: value,
                count: visits,
              })),
            }
          }
        )
      )
    } else if (
      section === "countries" ||
      section === "regions" ||
      section === "cities"
    ) {
      const dimension: LocationDimension =
        section === "countries"
          ? "country"
          : section === "regions"
            ? "region"
            : "city"
      queries.push(
        computeTopLocations(site, resolved, dimension, 10, reporting).then(
          (list) => {
            snapshot.sections[section] = {
              total: list.total,
              rows: list.rows.map((row) => ({
                label: publicLocationLabel(section, row),
                count: row.visits,
                country: row.country,
              })),
            }
          }
        )
      )
    }
  }
  await Promise.all(queries)
  return snapshot
}
