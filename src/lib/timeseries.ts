import { and, eq, sql } from "drizzle-orm"
import { cachedDateFilter, getReportingSlices } from "./reporting-slices"
import type { ReportingSlices } from "./reporting-slices"
import type { Site } from "@/db/schema"
import type { ResolvedRange } from "@/lib/dates"
import { db } from "@/db"
import { dailySummary } from "@/db/schema"
import { startOfDayUtcMs } from "@/lib/dates"

export interface TimeseriesPoint {
  /** UTC epoch ms, including distinct instants for repeated local hours. */
  timestamp: number
  pageviews: number
  visitors: number
}
interface Bucket {
  startSec: number
  endSec: number
}

/** Bind boundaries as data, keeping SQL size and parameter count constant.
 * Range joins use the page-time and visit-activity indexes. A visit spanning
 * midnight contributes a visitor to each day, but remains one visit.
 */
async function rawBuckets(siteId: string, buckets: Array<Bucket>) {
  if (!buckets.length)
    return {
      pages: new Map<number, number>(),
      visitors: new Map<number, number>(),
    }
  const boundaries = JSON.stringify(
    buckets.map(({ startSec, endSec }, index) => [
      startSec,
      endSec,
      index === 0 || buckets[index - 1].endSec !== startSec ? 1 : 0,
    ])
  )
  const bucketTable = sql`WITH RECURSIVE buckets AS MATERIALIZED (
    SELECT CAST(key AS INTEGER) AS ordinal, CAST(json_extract(value, '$[2]') AS INTEGER) AS first_in_window, CAST(json_extract(value, '$[0]') AS INTEGER) AS start_sec,
      CAST(json_extract(value, '$[1]') AS INTEGER) AS end_sec
    FROM json_each(${boundaries})
  )`
  const [pageRows, visitorRows] = await Promise.all([
    db.all<{ bucket: number; count: number }>(sql`${bucketTable}
      SELECT b.start_sec AS bucket, COUNT(*) AS count FROM buckets b
      JOIN pages p ON p.site_id = ${siteId} AND p.timestamp >= b.start_sec AND p.timestamp < b.end_sec
      GROUP BY b.start_sec`),
    db.all<{ bucket: number; count: number }>(sql`${bucketTable},
      activity(visitor_id, ended_at, ordinal) AS (
        SELECT v.visitor_id, v.ended_at, b.ordinal FROM buckets b
        CROSS JOIN visits v INDEXED BY idx_visits_site_started_visitor
          WHERE v.site_id = ${siteId} AND v.started_at >= b.start_sec AND v.started_at < b.end_sec
        UNION
        SELECT v.visitor_id, v.ended_at, b.ordinal FROM buckets b
        CROSS JOIN visits v INDEXED BY idx_visits_site_ended_started_visitor
          WHERE b.first_in_window = 1 AND v.site_id = ${siteId} AND v.ended_at >= b.start_sec AND v.started_at < b.start_sec
        UNION
        SELECT a.visitor_id, a.ended_at, next.ordinal FROM activity a
        JOIN buckets current ON current.ordinal = a.ordinal
        JOIN buckets next ON next.ordinal = a.ordinal + 1 AND next.start_sec = current.end_sec
          AND a.ended_at >= next.start_sec
      )
      SELECT b.start_sec AS bucket, COUNT(DISTINCT a.visitor_id) AS count
      FROM activity a JOIN buckets b ON b.ordinal = a.ordinal GROUP BY b.start_sec`),
  ])
  return {
    pages: new Map(
      pageRows.map((row) => [Number(row.bucket), Number(row.count)])
    ),
    visitors: new Map(
      visitorRows.map((row) => [Number(row.bucket), Number(row.count)])
    ),
  }
}

export async function computeTimeseries(
  site: Site,
  resolved: ResolvedRange,
  reporting?: ReportingSlices
): Promise<Array<TimeseriesPoint>> {
  if (
    resolved.fromDate === resolved.today &&
    resolved.toDate === resolved.today
  )
    return computeHourlyPoints(site, resolved.today)

  const slices = reporting ?? (await getReportingSlices(site, resolved))
  const [cached, raw] = await Promise.all([
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
    rawBuckets(
      site.id,
      slices.days.filter((day) => !day.cached)
    ),
  ])
  const byDate = new Map(cached.map((row) => [row.date, row]))
  return slices.days.map((day) => ({
    timestamp: day.startSec * 1000,
    pageviews: day.cached
      ? (byDate.get(day.date)?.pageviews ?? 0)
      : (raw.pages.get(day.startSec) ?? 0),
    visitors: day.cached
      ? (byDate.get(day.date)?.visitors ?? 0)
      : (raw.visitors.get(day.startSec) ?? 0),
  }))
}

async function computeHourlyPoints(
  site: Site,
  today: string
): Promise<Array<TimeseriesPoint>> {
  const next = new Date(`${today}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  const start = Math.floor(startOfDayUtcMs(today, site.timezone) / 1000)
  const end = Math.min(
    Math.floor(Date.now() / 1000) + 1,
    Math.floor(
      startOfDayUtcMs(next.toISOString().slice(0, 10), site.timezone) / 1000
    )
  )
  const buckets: Array<Bucket> = []
  for (let instant = start; instant < end; instant += 3600)
    buckets.push({ startSec: instant, endSec: Math.min(instant + 3600, end) })
  const raw = await rawBuckets(site.id, buckets)
  return buckets.map((bucket) => ({
    timestamp: bucket.startSec * 1000,
    pageviews: raw.pages.get(bucket.startSec) ?? 0,
    visitors: raw.visitors.get(bucket.startSec) ?? 0,
  }))
}
