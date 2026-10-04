import { and, eq, gte, lt, lte, or, sql } from "drizzle-orm"
import { dateRangeList, startOfDayUtcMs } from "./dates"
import type { ResolvedRange } from "./dates"
import type { SQL } from "drizzle-orm"
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import type { Site } from "@/db/schema"
import { db } from "@/db"
import { dailyRollupStatus } from "@/db/schema"

export const ROLLUP_VERSION = 2

interface DaySlice {
  date: string
  startSec: number
  endSec: number
  cached: boolean
}
export interface ReportingSlices {
  days: Array<DaySlice>
  cached: Array<{ from: string; to: string }>
  raw: Array<{ startSec: number; endSec: number }>
}

export async function getReportingSlices(
  site: Site,
  range: ResolvedRange
): Promise<ReportingSlices> {
  const markers = await db
    .select()
    .from(dailyRollupStatus)
    .where(
      and(
        eq(dailyRollupStatus.siteId, site.id),
        gte(dailyRollupStatus.date, range.fromDate),
        lte(dailyRollupStatus.date, range.toDate)
      )
    )
  const byDate = new Map(markers.map((row) => [row.date, row]))
  const dates = dateRangeList(range.fromDate, range.toDate)
  const nowSec = Math.floor(Date.now() / 1000) + 1
  const days = dates
    .map((date) => {
      const next = new Date(`${date}T00:00:00Z`)
      next.setUTCDate(next.getUTCDate() + 1)
      const startSec = Math.floor(startOfDayUtcMs(date, site.timezone) / 1000)
      const dayEnd = Math.floor(
        startOfDayUtcMs(next.toISOString().slice(0, 10), site.timezone) / 1000
      )
      const marker = byDate.get(date)
      return {
        date,
        startSec,
        endSec: Math.min(dayEnd, nowSec),
        cached:
          date < range.today &&
          marker?.version === ROLLUP_VERSION &&
          marker.startSec === startSec &&
          marker.endSec === dayEnd,
      }
    })
    .filter((day) => day.endSec > day.startSec)
  const cached: ReportingSlices["cached"] = []
  const raw: ReportingSlices["raw"] = []
  let previousCached = false
  for (const day of days) {
    if (day.cached) {
      if (previousCached) cached[cached.length - 1].to = day.date
      else cached.push({ from: day.date, to: day.date })
    } else if (!previousCached && raw.at(-1)?.endSec === day.startSec) {
      raw[raw.length - 1].endSec = day.endSec
    } else raw.push({ startSec: day.startSec, endSec: day.endSec })
    previousCached = day.cached
  }
  // D1 has a bound-parameter limit. Fragmented caches fall back to one raw scan.
  if (cached.length + raw.length > 16 && days.length) {
    days.forEach((day) => {
      day.cached = false
    })
    return {
      days,
      cached: [],
      raw: [
        { startSec: days[0].startSec, endSec: days[days.length - 1].endSec },
      ],
    }
  }
  return { days, cached, raw }
}

export function cachedDateFilter(
  column: AnySQLiteColumn,
  slices: ReportingSlices
): SQL {
  return (
    or(
      ...slices.cached.map((window) =>
        and(gte(column, window.from), lte(column, window.to))
      )
    ) ?? sql`0`
  )
}
export function rawTimeFilter(
  column: AnySQLiteColumn,
  slices: Pick<ReportingSlices, "raw">
): SQL {
  return (
    or(
      ...slices.raw.map((window) =>
        and(gte(column, window.startSec), lt(column, window.endSec))
      )
    ) ?? sql`0`
  )
}

/** Invalidate the report's day and the originating visit's day in the same transaction. */
export function invalidateReportingDay(
  siteId: string,
  occurredSec: number,
  visitId?: string,
  pageId?: number
): SQL {
  return sql`DELETE FROM daily_rollup_status WHERE site_id = ${siteId} AND (
    (start_sec <= ${occurredSec} AND end_sec > ${occurredSec})
    OR EXISTS (SELECT 1 FROM visits v WHERE v.id = ${pageId === undefined ? sql`${visitId ?? ""}` : sql`(SELECT visit_id FROM pages WHERE id = ${pageId})`}
      AND v.started_at < daily_rollup_status.end_sec AND MAX(v.ended_at, ${occurredSec}) >= daily_rollup_status.start_sec)
  )`
}
