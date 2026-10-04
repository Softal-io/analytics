import { and, eq, gte, lt, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { rawTimeFilter } from "./reporting-slices"
import type { ReportingSlices } from "./reporting-slices"
import { db } from "@/db"
import { pages, visits } from "@/db/schema"

/**
 * Aggregates raw rows for today or a historical interval without a current cache.
 */
export interface RawDayStats {
  visitors: number
  visits: number
  pageviews: number
  bounceRate: number
  avgDurationSeconds: number
}

export async function computeRawStats(
  siteId: string,
  startSec: number,
  endSec: number
): Promise<RawDayStats> {
  return computeRawStatsForSlices(siteId, { raw: [{ startSec, endSec }] })
}

export async function computeRawStatsForSlices(
  siteId: string,
  slices: Pick<ReportingSlices, "raw">
): Promise<RawDayStats> {
  const activity = alias(visits, "activity")
  const visitorCount = db
    .select({ count: sql<number>`COUNT(DISTINCT ${activity.visitorId})` })
    .from(activity)
    .where(
      and(
        eq(activity.siteId, siteId),
        or(
          ...slices.raw.map((window) =>
            and(
              lt(activity.startedAt, window.endSec),
              gte(activity.endedAt, window.startSec)
            )
          )
        ) ?? sql`0`
      )
    )
  // Independent queries — fire together. Each D1 round-trip has real
  // cost (esp. cross-region), so awaiting them one at a time here would
  // double the latency for no reason.
  const [visitRow, pageRow] = await Promise.all([
    db
      .select({
        visitors: sql<number>`(${visitorCount})`,
        visits: sql<number>`COUNT(*)`,
        bounceRate: sql<number>`COALESCE(AVG(${visits.isBounce}), 0)`,
        avgDuration: sql<number>`COALESCE(AVG(COALESCE(${visits.durationMs} / 1000.0, ${visits.endedAt} - ${visits.startedAt})), 0)`,
      })
      .from(visits)
      .where(
        and(eq(visits.siteId, siteId), rawTimeFilter(visits.startedAt, slices))
      )
      .get(),
    db
      .select({ pageviews: sql<number>`COUNT(*)` })
      .from(pages)
      .where(
        and(eq(pages.siteId, siteId), rawTimeFilter(pages.timestamp, slices))
      )
      .get(),
  ])

  return {
    visitors: Number(visitRow?.visitors ?? 0),
    visits: Number(visitRow?.visits ?? 0),
    pageviews: Number(pageRow?.pageviews ?? 0),
    bounceRate: Number(visitRow?.bounceRate ?? 0),
    avgDurationSeconds: Number(visitRow?.avgDuration ?? 0),
  }
}
