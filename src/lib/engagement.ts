import { and, desc, eq, gte, sql } from "drizzle-orm"
import { runBatch } from "./d1-batch"
import { invalidateReportingDay } from "./reporting-slices"
import { reconcileVisits, resolvePage } from "./session"
import { visits } from "@/db/schema"
import { db } from "@/db"

/** Resolve legacy actions to their original visit, including late navigation beacons. */
export async function findActionVisit(
  siteId: string,
  visitorId: string,
  nowSec: number,
  pageId?: string
) {
  if (pageId) {
    const page = await resolvePage(siteId, pageId)
    return page?.visitorId === visitorId ? { id: page.visitId } : undefined
  }
  return db
    .select({ id: visits.id })
    .from(visits)
    .where(
      and(
        eq(visits.siteId, siteId),
        eq(visits.visitorId, visitorId),
        gte(visits.endedAt, nowSec - 30 * 60)
      )
    )
    .orderBy(desc(visits.startedAt))
    .limit(1)
    .get()
}

interface PageTiming {
  elapsedMs: number
  activityMs: number
  reportKeyHash: string
}

/** Cumulative totals add only the delta. A private page key permits network changes. */
export async function recordEngagement(
  siteId: string,
  visitorId: string,
  pageId: string,
  durationMs: number,
  nowSec: number,
  timing?: PageTiming
) {
  const page = await resolvePage(siteId, pageId)
  if (
    !page ||
    (timing
      ? page.reportKeyHash !== timing.reportKeyHash
      : page.visitorId !== visitorId)
  )
    return false
  const boundedMs = Math.min(
    durationMs,
    timing?.elapsedMs ?? Math.max(0, (nowSec - page.timestamp + 1) * 1000)
  )
  const activitySec = timing
    ? Math.min(
        nowSec,
        Math.floor(
          ((page.timestampMs ?? page.timestamp * 1000) + timing.activityMs) /
            1000
        )
      )
    : nowSec
  await runBatch([
    invalidateReportingDay(siteId, activitySec, undefined, page.id),
    sql`UPDATE visits SET
      duration_ms = COALESCE(duration_ms, MAX(0, ended_at - started_at) * 1000) + MAX(0, ${boundedMs} - (SELECT duration_ms FROM pages WHERE id = ${page.id})),
      is_bounce = CASE WHEN COALESCE(duration_ms, MAX(0, ended_at - started_at) * 1000) + MAX(0, ${boundedMs} - (SELECT duration_ms FROM pages WHERE id = ${page.id})) > 10000 THEN 0 ELSE is_bounce END,
      ended_at = CASE WHEN ${boundedMs} > (SELECT duration_ms FROM pages WHERE id = ${page.id}) THEN MAX(ended_at, ${activitySec}) ELSE ended_at END
      WHERE id = (SELECT visit_id FROM pages WHERE id = ${page.id})`,
    sql`UPDATE pages SET duration_ms = MAX(duration_ms, ${boundedMs}) WHERE id = ${page.id}`,
    ...reconcileVisits(siteId, pageId),
  ])
  return true
}

/** Outbound clicks and explicitly tracked custom events are meaningful actions. */
export async function recordInteraction(
  siteId: string,
  visitorId: string,
  nowSec: number,
  pageId?: string
) {
  const visit = await findActionVisit(siteId, visitorId, nowSec, pageId)
  if (!visit) return null
  await runBatch([
    invalidateReportingDay(siteId, nowSec, visit.id),
    sql`UPDATE visits SET is_bounce = 0, ended_at = MAX(ended_at, ${nowSec}) WHERE id = ${visit.id}`,
  ])
  return visit.id
}
