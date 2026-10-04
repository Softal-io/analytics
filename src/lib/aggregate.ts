import { sql } from "drizzle-orm"
import { runBatch } from "./d1-batch"
import type { SQL } from "drizzle-orm"
import { db } from "@/db"
import { dailyRollupStatus, dailySummary, sites } from "@/db/schema"
import { dateRangeList, formatDateInTz, startOfDayUtcMs } from "@/lib/dates"
import { ROLLUP_VERSION } from "@/lib/reporting-slices"

/**
 * Daily rollup aggregation (§7). Runs hourly from the cron trigger in
 * `src/server.ts`. For each site, rolls up the just-completed day (in that
 * site's own timezone) from the raw tables into the `daily_*` tables.
 *
 * Every day is replaced in one transaction. Re-running it after a failure
 * is safe, and the cache marker is published with the data.
 */
// Two reads, two cleanup statements, three 15-statement rollups, and at most
// one failure-state write stay within the 50-query budget.
const MAX_ROLLUP_DAYS = 3
const RETRY_BASE_SECONDS = 2 * 3600
const RETRY_MAX_SECONDS = 24 * 3600

export async function runDailyAggregation(): Promise<void> {
  const allSites = await db
    .select({
      site: sites,
      firstTimestamp: sql<number | null>`(SELECT MIN(timestamp) FROM (
      SELECT MIN(started_at) AS timestamp FROM visits WHERE site_id = "sites"."id"
      UNION ALL SELECT MIN(timestamp) FROM pages WHERE site_id = "sites"."id"
      UNION ALL SELECT MIN(timestamp) FROM events WHERE site_id = "sites"."id"
      UNION ALL SELECT MIN(timestamp) FROM outbound_links WHERE site_id = "sites"."id"
    ))`,
    })
    .from(sites)
  const metadata = await db
    .select({
      siteId: dailySummary.siteId,
      date: dailySummary.date,
      startSec: dailyRollupStatus.startSec,
      endSec: dailyRollupStatus.endSec,
      version: dailyRollupStatus.version,
      failures: sql<number>`COALESCE(${dailyRollupStatus.failures}, 0)`,
      retryAt: sql<number>`COALESCE(${dailyRollupStatus.retryAt}, 0)`,
    })
    .from(dailySummary)
    .leftJoin(
      dailyRollupStatus,
      sql`${dailyRollupStatus.siteId} = ${dailySummary.siteId} AND ${dailyRollupStatus.date} = ${dailySummary.date}`
    )
    .unionAll(
      db
        .select({
          siteId: dailyRollupStatus.siteId,
          date: dailyRollupStatus.date,
          startSec: dailyRollupStatus.startSec,
          endSec: dailyRollupStatus.endSec,
          version: dailyRollupStatus.version,
          failures: dailyRollupStatus.failures,
          retryAt: dailyRollupStatus.retryAt,
        })
        .from(dailyRollupStatus).where(sql`NOT EXISTS (
        SELECT 1 FROM daily_summary s WHERE s.site_id = ${dailyRollupStatus.siteId}
          AND s.date = ${dailyRollupStatus.date}
      )`)
    )
  await runBatch([
    sql`DELETE FROM tracking_contexts WHERE last_seen < ${Math.floor(Date.now() / 1000) - 2 * 86400}`,
    sql`DELETE FROM source_details_cache WHERE expires_at <= ${Math.floor(Date.now() / 1000)}`,
  ])
  const nowSec = Math.floor(Date.now() / 1000)
  const pending: Array<{
    siteId: string
    timezone: string
    date: string
    startSec: number
    endSec: number
    failures: number
  }> = []
  for (const { site, firstTimestamp } of allSites) {
    try {
      const previous = previousDateInTz(site.timezone)
      const known = metadata.filter((day) => day.siteId === site.id)
      let firstDate =
        firstTimestamp === null
          ? previous
          : formatDateInTz(new Date(firstTimestamp * 1000), site.timezone)
      for (const day of known) if (day.date < firstDate) firstDate = day.date
      const byDate = new Map(known.map((day) => [day.date, day]))
      for (const date of dateRangeList(firstDate, previous)) {
        const startSec = Math.floor(startOfDayUtcMs(date, site.timezone) / 1000)
        const endSec = Math.floor(
          startOfDayUtcMs(nextDateStr(date), site.timezone) / 1000
        )
        const cached = byDate.get(date)
        if (
          cached?.version === ROLLUP_VERSION &&
          cached.startSec === startSec &&
          cached.endSec === endSec
        )
          continue
        const sameDay =
          cached?.startSec === startSec && cached.endSec === endSec
        if (sameDay && cached.retryAt > nowSec) continue
        pending.push({
          siteId: site.id,
          timezone: site.timezone,
          date,
          startSec,
          endSec,
          failures: sameDay ? cached.failures : 0,
        })
      }
    } catch (error) {
      console.error(
        "Aggregation planning failed",
        site.id,
        error instanceof Error ? error.message : "Unknown error"
      )
    }
  }
  // Take one day per website per round, rotating the first website each hour.
  // Recent days still go first within each website, regardless of its timezone.
  pending.sort((a, b) => b.endSec - a.endSec)
  const siteIds = [...new Set(pending.map((day) => day.siteId))].sort()
  const rotation = siteIds.length
    ? Math.floor(Date.now() / 3600000) % siteIds.length
    : 0
  const orderedSites = [
    ...siteIds.slice(rotation),
    ...siteIds.slice(0, rotation),
  ]
  const queues = new Map(
    orderedSites.map((id) => [id, pending.filter((day) => day.siteId === id)])
  )
  const selected: typeof pending = []
  while (selected.length < MAX_ROLLUP_DAYS) {
    let added = false
    for (const id of orderedSites) {
      const day = queues.get(id)!.shift()
      if (!day) continue
      selected.push(day)
      added = true
      if (selected.length === MAX_ROLLUP_DAYS) break
    }
    if (!added) break
  }
  const failures: Array<SQL> = []
  for (const day of selected) {
    try {
      await aggregateSiteDay(day.siteId, day.timezone, day.date)
    } catch (error) {
      const attempts = Math.min(day.failures + 1, 5)
      const retryAt =
        nowSec +
        Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * 2 ** (attempts - 1))
      failures.push(
        sql`(${day.siteId}, ${day.date}, ${day.startSec}, ${day.endSec}, 0, ${attempts}, ${retryAt})`
      )
      console.error(
        "Aggregation failed",
        day.siteId,
        day.date,
        error instanceof Error ? error.message : "Unknown error"
      )
    }
  }
  if (failures.length) {
    // A failed rollup has no summary row yet. Persist all retry states in one query.
    // Do not overwrite a matching successful marker from another invocation.
    await db.run(sql`INSERT INTO daily_rollup_status (site_id, date, start_sec, end_sec, version, failures, retry_at)
      VALUES ${sql.join(failures, sql`, `)}
      ON CONFLICT (site_id, date) DO UPDATE SET
        start_sec = excluded.start_sec, end_sec = excluded.end_sec, version = 0,
        failures = excluded.failures, retry_at = excluded.retry_at
      WHERE daily_rollup_status.version != ${ROLLUP_VERSION}
        OR daily_rollup_status.start_sec != excluded.start_sec
        OR daily_rollup_status.end_sec != excluded.end_sec`)
  }
}

function previousDateInTz(timezone: string): string {
  const today = formatDateInTz(new Date(), timezone)
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function nextDateStr(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** Rolls up a single site's single day. Exported for manual backfill. */
export async function aggregateSiteDay(
  siteId: string,
  timezone: string,
  date: string
): Promise<void> {
  const startSec = Math.floor(startOfDayUtcMs(date, timezone) / 1000)
  const endSec = Math.floor(startOfDayUtcMs(nextDateStr(date), timezone) / 1000)

  // Compute every table from the same database snapshot and publish the marker last.
  const statements = [
    ...[
      "daily_summary",
      "daily_pages",
      "daily_sources",
      "daily_devices",
      "daily_locations",
      "daily_outbound_links",
      "daily_events",
    ].map(
      (table) =>
        sql`DELETE FROM ${sql.identifier(table)} WHERE site_id = ${siteId} AND date = ${date}`
    ),
  ]

  statements.push(sql`
    INSERT INTO daily_summary (site_id, date, visitors, visits, pageviews, bounce_rate, avg_duration_seconds)
    SELECT
      ${siteId},
      ${date},
      COALESCE((SELECT COUNT(DISTINCT visitor_id) FROM visits WHERE site_id = ${siteId} AND ended_at >= ${startSec} AND started_at < ${endSec}), 0),
      COALESCE((SELECT COUNT(*) FROM visits WHERE site_id = ${siteId} AND started_at >= ${startSec} AND started_at < ${endSec}), 0),
      COALESCE((SELECT COUNT(*) FROM pages WHERE site_id = ${siteId} AND timestamp >= ${startSec} AND timestamp < ${endSec}), 0),
      COALESCE((SELECT AVG(is_bounce) FROM visits WHERE site_id = ${siteId} AND started_at >= ${startSec} AND started_at < ${endSec}), 0),
      COALESCE((SELECT AVG(COALESCE(duration_ms / 1000.0, ended_at - started_at)) FROM visits WHERE site_id = ${siteId} AND started_at >= ${startSec} AND started_at < ${endSec}), 0)
    ON CONFLICT (site_id, date) DO UPDATE SET
      visitors = excluded.visitors,
      visits = excluded.visits,
      pageviews = excluded.pageviews,
      bounce_rate = excluded.bounce_rate,
      avg_duration_seconds = excluded.avg_duration_seconds
  `)

  statements.push(sql`
    INSERT INTO daily_pages (site_id, date, path, pageviews, visitors, entrances, exits)
    SELECT
      ${siteId},
      ${date},
      path,
      SUM(pageviews), SUM(visitors), SUM(entrances), SUM(exits)
    FROM (
      SELECT p.path, COUNT(*) AS pageviews, COUNT(DISTINCT v.visitor_id) AS visitors, 0 AS entrances, 0 AS exits
      FROM pages p JOIN visits v ON v.id = p.visit_id
      WHERE p.site_id = ${siteId} AND p.timestamp >= ${startSec} AND p.timestamp < ${endSec}
      GROUP BY p.path
      UNION ALL
      SELECT entry_page AS path, 0, 0, COUNT(*), 0 FROM visits
      WHERE site_id = ${siteId} AND started_at >= ${startSec} AND started_at < ${endSec} AND entry_page IS NOT NULL
      GROUP BY entry_page
      UNION ALL
      SELECT exit_page AS path, 0, 0, 0, COUNT(*) FROM visits
      WHERE site_id = ${siteId} AND started_at >= ${startSec} AND started_at < ${endSec} AND exit_page IS NOT NULL
      GROUP BY exit_page
    ) GROUP BY path
    ON CONFLICT (site_id, date, path) DO UPDATE SET
      pageviews = excluded.pageviews,
      visitors = excluded.visitors,
      entrances = excluded.entrances,
      exits = excluded.exits
  `)

  statements.push(sql`
    INSERT INTO daily_sources (site_id, date, referrer_domain, utm_source, utm_medium, utm_campaign, visits)
    SELECT
      ${siteId},
      ${date},
      s.referrer_domain,
      COALESCE(s.utm_source, ''),
      COALESCE(s.utm_medium, ''),
      COALESCE(s.utm_campaign, ''),
      COUNT(*)
    FROM visits v
    JOIN sources s ON s.id = v.source_id
    WHERE v.site_id = ${siteId} AND v.started_at >= ${startSec} AND v.started_at < ${endSec}
    GROUP BY
      s.referrer_domain,
      COALESCE(s.utm_source, ''),
      COALESCE(s.utm_medium, ''),
      COALESCE(s.utm_campaign, '')
    ON CONFLICT (site_id, date, referrer_domain, utm_source, utm_medium, utm_campaign) DO UPDATE SET
      visits = excluded.visits
  `)

  statements.push(sql`
    INSERT INTO daily_devices (site_id, date, device_type, browser, os, visits)
    SELECT
      ${siteId},
      ${date},
      d.device_type,
      d.browser,
      d.os,
      COUNT(*)
    FROM visits v
    JOIN devices d ON d.id = v.device_id
    WHERE v.site_id = ${siteId} AND v.started_at >= ${startSec} AND v.started_at < ${endSec}
    GROUP BY d.device_type, d.browser, d.os
    ON CONFLICT (site_id, date, device_type, browser, os) DO UPDATE SET
      visits = excluded.visits
  `)

  statements.push(sql`
    INSERT INTO daily_locations (site_id, date, country, region, city, visits)
    SELECT
      ${siteId},
      ${date},
      l.country,
      COALESCE(l.region, ''),
      COALESCE(l.city, ''),
      COUNT(*)
    FROM visits v
    JOIN locations l ON l.id = v.location_id
    WHERE v.site_id = ${siteId} AND v.started_at >= ${startSec} AND v.started_at < ${endSec}
    GROUP BY l.country, COALESCE(l.region, ''), COALESCE(l.city, '')
    ON CONFLICT (site_id, date, country, region, city) DO UPDATE SET
      visits = excluded.visits
  `)

  statements.push(sql`
    INSERT INTO daily_outbound_links (site_id, date, url, clicks)
    SELECT
      ${siteId},
      ${date},
      o.url,
      COUNT(*)
    FROM outbound_links o
    WHERE o.site_id = ${siteId} AND o.timestamp >= ${startSec} AND o.timestamp < ${endSec}
    GROUP BY o.url
    ON CONFLICT (site_id, date, url) DO UPDATE SET
      clicks = excluded.clicks
  `)

  statements.push(sql`
    INSERT INTO daily_events (site_id, date, name, count)
    SELECT
      ${siteId},
      ${date},
      e.name,
      COUNT(*)
    FROM events e
    WHERE e.site_id = ${siteId} AND e.timestamp >= ${startSec} AND e.timestamp < ${endSec}
    GROUP BY e.name
    ON CONFLICT (site_id, date, name) DO UPDATE SET
      count = excluded.count
  `)
  statements.push(sql`INSERT INTO daily_rollup_status (site_id, date, start_sec, end_sec, version, failures, retry_at)
    VALUES (${siteId}, ${date}, ${startSec}, ${endSec}, ${ROLLUP_VERSION}, 0, 0)
    ON CONFLICT (site_id, date) DO UPDATE SET start_sec = excluded.start_sec, end_sec = excluded.end_sec,
      version = excluded.version, failures = 0, retry_at = 0`)
  await runBatch(statements)
}
