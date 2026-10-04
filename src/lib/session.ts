import { and, eq, sql } from "drizzle-orm"
import { runBatch } from "./d1-batch"
import { invalidateReportingDay } from "./reporting-slices"
import { db } from "@/db"
import { pages, visits } from "@/db/schema"

const SESSION_WINDOW_SEC = 30 * 60
export interface RecordPageParams {
  siteId: string
  visitorId: string
  path: string
  timestampMs: number
  sourceId: number | null
  referrerUrl?: string | null
  landingUrl?: string | null
  deviceId: number | null
  locationId: number | null
  measureDuration?: boolean
  pageId?: string
  reportKeyHash?: string
  title?: string | null
}
export interface RecordPageResult {
  visitId: string
  isNewVisit: boolean
}

/** Insert a page and change its visit together. Replaying a page ID changes neither. */
export async function recordPage(
  params: RecordPageParams
): Promise<RecordPageResult> {
  const {
    siteId,
    visitorId,
    path,
    timestampMs,
    sourceId,
    deviceId,
    locationId,
  } = params
  const timestamp = Math.floor(timestampMs / 1000)
  const pageId = params.pageId ?? crypto.randomUUID()
  const newVisitId = crypto.randomUUID()
  const candidate = sql`SELECT id FROM visits WHERE site_id = ${siteId} AND visitor_id = ${visitorId}
    AND started_at < ${timestamp + SESSION_WINDOW_SEC} AND ended_at > ${timestamp - SESSION_WINDOW_SEC}
    ORDER BY started_at DESC LIMIT 1`
  const noPage = sql`NOT EXISTS (SELECT 1 FROM pages WHERE site_id = ${siteId} AND tracking_id = ${pageId})`
  const firstPage = sql`${timestampMs} <= COALESCE((SELECT MIN(COALESCE(timestamp_ms, timestamp * 1000)) FROM pages WHERE visit_id = visits.id AND (tracking_id IS NULL OR tracking_id != ${pageId})), ${timestampMs})`
  const lastPage = sql`${timestampMs} >= COALESCE((SELECT MAX(COALESCE(timestamp_ms, timestamp * 1000)) FROM pages WHERE visit_id = visits.id AND (tracking_id IS NULL OR tracking_id != ${pageId})), ${timestampMs})`
  const result = await runBatch([
    sql`DELETE FROM daily_rollup_status WHERE site_id = ${siteId} AND EXISTS (SELECT 1 FROM visits WHERE id = (${candidate}) AND started_at >= start_sec AND started_at < end_sec)`,
    sql`INSERT INTO visits (id, site_id, visitor_id, started_at, ended_at, duration_ms, entry_page, exit_page, page_count, is_bounce, source_id, device_id, location_id, referrer_url, landing_url)
      SELECT ${newVisitId}, ${siteId}, ${visitorId}, ${timestamp}, ${timestamp}, ${params.measureDuration ? 0 : null}, ${path}, ${path}, 0, 1, ${sourceId}, ${deviceId}, ${locationId}, ${params.referrerUrl ?? null}, ${params.landingUrl ?? null}
      WHERE ${noPage} AND NOT EXISTS (${candidate})`,
    sql`INSERT INTO pages (site_id, visit_id, path, title, timestamp, timestamp_ms, tracking_id, report_key_hash)
      SELECT ${siteId}, (${candidate}), ${path}, ${params.title ?? null}, ${timestamp}, ${timestampMs}, ${pageId}, ${params.reportKeyHash ?? null}
      WHERE ${noPage} ON CONFLICT (site_id, tracking_id) DO NOTHING`,
    sql`UPDATE visits SET
      duration_ms = CASE WHEN ${params.measureDuration ? 1 : 0} THEN COALESCE(duration_ms, MAX(0, ended_at - started_at) * 1000)
        WHEN duration_ms IS NOT NULL THEN duration_ms + MAX(0, ${timestamp} - ended_at) * 1000 ELSE NULL END,
      entry_page = CASE WHEN ${firstPage} THEN ${path} ELSE entry_page END,
      source_id = CASE WHEN ${firstPage} THEN ${sourceId} ELSE source_id END,
      referrer_url = CASE WHEN ${firstPage} THEN ${params.referrerUrl ?? null} ELSE referrer_url END,
      landing_url = CASE WHEN ${firstPage} THEN ${params.landingUrl ?? null} ELSE landing_url END,
      device_id = CASE WHEN ${firstPage} THEN ${deviceId} ELSE device_id END,
      location_id = CASE WHEN ${firstPage} THEN ${locationId} ELSE location_id END,
      exit_page = CASE WHEN ${lastPage} THEN ${path} ELSE exit_page END,
      started_at = MIN(started_at, ${timestamp}), ended_at = MAX(ended_at, ${timestamp}),
      page_count = page_count + 1, is_bounce = CASE WHEN page_count >= 1 THEN 0 ELSE is_bounce END
      WHERE id = (SELECT visit_id FROM pages WHERE site_id = ${siteId} AND tracking_id = ${pageId}) AND changes() > 0`,
    // The old start day may change when an earlier page arrives out of order.
    sql`DELETE FROM daily_rollup_status WHERE site_id = ${siteId} AND EXISTS (
      SELECT 1 FROM visits v JOIN pages p ON p.visit_id = v.id WHERE p.site_id = ${siteId} AND p.tracking_id = ${pageId}
      AND ((v.started_at >= start_sec AND v.started_at < end_sec) OR (p.timestamp >= start_sec AND p.timestamp < end_sec)))`,
    invalidateReportingDay(siteId, timestamp),
    ...reconcileVisits(siteId, pageId),
  ])
  const page = await db
    .select({ visitId: pages.visitId })
    .from(pages)
    .where(and(eq(pages.siteId, siteId), eq(pages.trackingId, pageId)))
    .get()
  if (!page) throw new Error("Page insert did not resolve a visit")
  return {
    visitId: page.visitId,
    isNewVisit: page.visitId === newVisitId && result[1].meta.changes > 0,
  }
}

/** Merge a connected session component atomically after late pages or activity.
 * Resolve membership inside each statement, rather than from a stale JS read.
 * Keep the earliest visit, preserving its attribution and moving every foreign key.
 */
export function reconcileVisits(siteId: string, pageId: string) {
  const connected = sql`WITH RECURSIVE connected(id) AS (
    SELECT visit_id FROM pages WHERE site_id = ${siteId} AND tracking_id = ${pageId}
    UNION
    SELECT v.id FROM connected link JOIN visits c ON c.id = link.id
    JOIN visits v ON v.site_id = ${siteId} AND v.visitor_id = c.visitor_id
    WHERE v.started_at < c.ended_at + ${SESSION_WINDOW_SEC}
      AND v.ended_at > c.started_at - ${SESSION_WINDOW_SEC}
  ), members AS MATERIALIZED (SELECT * FROM visits WHERE id IN (SELECT id FROM connected)),
  canonical AS (SELECT id FROM members ORDER BY started_at, id LIMIT 1)`
  // UNION deduplicates visited IDs, including cycles and transitive bridges.
  return [
    sql`${connected} DELETE FROM daily_rollup_status WHERE site_id = ${siteId}
      AND (SELECT COUNT(*) FROM members) > 1 AND EXISTS (
        SELECT 1 FROM members WHERE started_at < end_sec AND ended_at >= start_sec)`,
    sql`${connected} UPDATE visits SET
      started_at = (SELECT MIN(started_at) FROM members), ended_at = (SELECT MAX(ended_at) FROM members),
      duration_ms = (SELECT SUM(COALESCE(duration_ms, MAX(0, ended_at - started_at) * 1000)) FROM members),
      page_count = (SELECT SUM(page_count) FROM members), is_bounce = 0,
      exit_page = (SELECT exit_page FROM members ORDER BY
        COALESCE((SELECT MAX(COALESCE(p.timestamp_ms, p.timestamp * 1000)) FROM pages p WHERE p.visit_id = members.id), started_at * 1000) DESC, id DESC LIMIT 1)
      WHERE id = (SELECT id FROM canonical) AND (SELECT COUNT(*) FROM members) > 1`,
    sql`${connected} UPDATE pages SET visit_id = (SELECT id FROM canonical)
      WHERE visit_id IN (SELECT id FROM connected) AND visit_id != (SELECT id FROM canonical)`,
    sql`${connected} UPDATE events SET visit_id = (SELECT id FROM canonical)
      WHERE visit_id IN (SELECT id FROM connected) AND visit_id != (SELECT id FROM canonical)`,
    sql`${connected} DELETE FROM visits WHERE id IN (SELECT id FROM connected) AND id != (SELECT id FROM canonical)`,
  ]
}

export async function hashReportKey(key: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key)
  )
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

export async function resolvePage(siteId: string, pageId: string) {
  return db
    .select({
      id: pages.id,
      visitId: pages.visitId,
      visitorId: visits.visitorId,
      reportKeyHash: pages.reportKeyHash,
      timestamp: pages.timestamp,
      timestampMs: pages.timestampMs,
    })
    .from(pages)
    .innerJoin(visits, eq(visits.id, pages.visitId))
    .where(and(eq(pages.siteId, siteId), eq(pages.trackingId, pageId)))
    .get()
}
