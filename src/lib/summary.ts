import { and, eq, gte, lt, sql } from "drizzle-orm"
import {
  cachedDateFilter,
  getReportingSlices,
  reportSlices,
} from "./reporting-slices"
import { hasVisitFilters } from "./visit-filter-schema"
import { visitsFilter } from "./visit-filters"
import type { ReportingSlices } from "./reporting-slices"
import type { VisitFilters } from "./visit-filter-schema"
import type { Site } from "@/db/schema"
import type { ResolvedRange } from "@/lib/dates"
import { previousRange } from "@/lib/dates"
import { db } from "@/db"
import { dailySummary, visits } from "@/db/schema"
import { computeRawStatsForSlices } from "@/lib/raw-stats"

export interface SummaryResult {
  visitors: number
  visits: number
  pageviews: number
  bounceRate: number
  avgDurationSeconds: number
}

/**
 * Combines current rollups with raw data for uncached intervals.
 * Unique visitors use an indexed distinct query across the entire
 * range, since daily distinct counts cannot be added without duplication.
 */
export async function computeSummary(
  site: Site,
  resolved: ResolvedRange,
  reporting?: ReportingSlices,
  filters?: VisitFilters
): Promise<SummaryResult> {
  const slices = await reportSlices(
    site,
    resolved,
    reporting,
    hasVisitFilters(filters)
  )
  let visitsTotal = 0
  let pageviewsTotal = 0
  let bounceWeighted = 0
  let durationWeighted = 0
  const [rollupRows, rawStats, unique] = await Promise.all([
    slices.cached.length
      ? db
          .select()
          .from(dailySummary)
          .where(
            and(
              eq(dailySummary.siteId, site.id),
              cachedDateFilter(dailySummary.date, slices)
            )
          )
      : Promise.resolve([]),
    slices.raw.length
      ? computeRawStatsForSlices(site.id, slices, filters)
      : Promise.resolve(null),
    slices.days.length
      ? db
          .select({
            visitors: sql<number>`COUNT(DISTINCT ${visits.visitorId})`,
          })
          .from(visits)
          .where(
            and(
              eq(visits.siteId, site.id),
              gte(visits.endedAt, slices.days[0].startSec),
              lt(visits.startedAt, slices.days[slices.days.length - 1].endSec),
              visitsFilter(site.id, filters)
            )
          )
          .get()
      : Promise.resolve(null),
  ])

  for (const r of rollupRows) {
    visitsTotal += r.visits
    pageviewsTotal += r.pageviews
    bounceWeighted += r.bounceRate * r.visits
    durationWeighted += r.avgDurationSeconds * r.visits
  }

  if (rawStats) {
    const raw = rawStats
    visitsTotal += raw.visits
    pageviewsTotal += raw.pageviews
    bounceWeighted += raw.bounceRate * raw.visits
    durationWeighted += raw.avgDurationSeconds * raw.visits
  }

  return {
    visitors: Number(unique?.visitors ?? 0),
    visits: visitsTotal,
    pageviews: pageviewsTotal,
    bounceRate: visitsTotal > 0 ? bounceWeighted / visitsTotal : 0,
    avgDurationSeconds: visitsTotal > 0 ? durationWeighted / visitsTotal : 0,
  }
}

export interface SummaryComparison extends SummaryResult {
  range: Pick<ResolvedRange, "fromDate" | "toDate">
  /** Set when the earlier period stops at the same time of day as now. */
  untilSec?: number
}

/**
 * The same summary for the equally long period just before `resolved`.
 * Completed days come from rollups, so this adds one rollup read, one
 * distinct-visitor count, and raw counts for at most the final partial day.
 */
export async function computePreviousSummary(
  site: Site,
  resolved: ResolvedRange,
  filters?: VisitFilters
): Promise<SummaryComparison> {
  const previous = previousRange(resolved, site.timezone)
  const slices = await getReportingSlices(site, previous.resolved, {
    untilSec: previous.untilSec,
    forceRaw: hasVisitFilters(filters),
  })
  const summary = await computeSummary(site, previous.resolved, slices, filters)
  return {
    ...summary,
    range: {
      fromDate: previous.resolved.fromDate,
      toDate: previous.resolved.toDate,
    },
    untilSec: previous.untilSec,
  }
}
