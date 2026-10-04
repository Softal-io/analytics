import { and, eq, gt, sql } from "drizzle-orm"
import { z } from "zod"
import { startOfDayUtcMs } from "./dates"
import {
  MAX_RECORDED_URL_CHARS,
  SOURCE_DETAILS_CACHE_SECONDS,
  SOURCE_URLS_PER_KIND,
} from "./analytics-config"
import { hashReportKey } from "./session"
import type { SQL } from "drizzle-orm"
import type { Site } from "@/db/schema"
import type { ResolvedRange } from "./dates"
import type { SourceDetails, SourceLink } from "./source-details"
import { db } from "@/db"
import { sourceDetailsCache } from "@/db/schema"

export const sourceDetailsRequestSchema = z.object({
  view: z.enum(["referrer", "utm"]),
  key: z.string().min(1).max(6000),
})
export type SourceDetailsRequest = z.infer<typeof sourceDetailsRequestSchema>
const campaignKeySchema = z.tuple([
  z.string().max(200),
  z.string().max(200),
  z.string().max(500),
])

export function sourceSelection(
  input: SourceDetailsRequest
): { details: SourceDetails; key: string; matches: Array<SQL> } | undefined {
  if (input.view === "referrer") {
    if (input.key.length > MAX_RECORDED_URL_CHARS) return undefined
    return {
      details: { referrerDomain: input.key, links: [], linkCount: 0 },
      key: input.key,
      matches: [sql`s.referrer_domain = ${input.key}`],
    }
  }
  try {
    const parsed = campaignKeySchema.safeParse(JSON.parse(input.key))
    if (!parsed.success || !parsed.data.some(Boolean)) return undefined
    const [source, medium, campaign] = parsed.data
    // Each legacy NULL variant gets a complete index lookup. An OR filter
    // around the columns makes SQLite scan every source belonging to the site.
    const variants = parsed.data.reduce<Array<Array<string | null>>>(
      (rows, value) =>
        rows.flatMap((row) =>
          (value === "" ? ["", null] : [value]).map((part) => [...row, part])
        ),
      [[]]
    )
    const match = (column: SQL, value: string | null) =>
      value === null ? sql`${column} IS NULL` : sql`${column} = ${value}`
    return {
      details: {
        utmSource: source,
        utmMedium: medium,
        utmCampaign: campaign,
        links: [],
        linkCount: 0,
      },
      key: JSON.stringify(parsed.data),
      matches: variants.map(
        ([a, b, c]) =>
          sql`${match(sql`s.utm_source`, a)} AND ${match(sql`s.utm_medium`, b)} AND ${match(sql`s.utm_campaign`, c)}`
      ),
    }
  } catch {
    return undefined
  }
}

// Collapse concurrent misses within a Worker. D1 persists results across Workers.
const pending = new Map<string, Promise<SourceDetails | undefined>>()

export async function loadSourceUrlDetails(
  site: Site,
  range: ResolvedRange,
  input: SourceDetailsRequest
): Promise<SourceDetails | undefined> {
  const selection = sourceSelection(input)
  if (!selection) return undefined
  const sourceIndex =
    input.view === "utm" ? "idx_sources_site_campaign" : "idx_sources_unique"
  const matchingSources = sql.join(
    selection.matches.map(
      (
        where
      ) => sql`SELECT s.id FROM sources s INDEXED BY ${sql.identifier(sourceIndex)}
        WHERE s.site_id = ${site.id} AND ${where}`
    ),
    sql` UNION ALL `
  )
  const key = await hashReportKey(
    JSON.stringify([
      range.fromDate,
      range.toDate,
      site.timezone,
      input.view,
      selection.key,
      MAX_RECORDED_URL_CHARS,
      SOURCE_URLS_PER_KIND,
    ])
  )
  const pendingKey = `${site.id}:${key}`
  const existing = pending.get(pendingKey)
  if (existing) return existing
  const request = load()
  pending.set(pendingKey, request)
  try {
    return await request
  } finally {
    pending.delete(pendingKey)
  }

  async function load() {
    const now = Math.floor(Date.now() / 1000)
    const cached = await db
      .select()
      .from(sourceDetailsCache)
      .where(
        and(
          eq(sourceDetailsCache.siteId, site.id),
          eq(sourceDetailsCache.key, key),
          gt(sourceDetailsCache.expiresAt, now)
        )
      )
      .get()
    if (cached) return cached.details
    const source = await db.all<{ id: number }>(
      sql`SELECT id FROM (${matchingSources}) LIMIT 1`
    )
    if (source.length === 0) return undefined
    const start = Math.floor(
      startOfDayUtcMs(range.fromDate, site.timezone) / 1000
    )
    const next = new Date(`${range.toDate}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    const end = Math.min(
      now + 1,
      Math.floor(
        startOfDayUtcMs(next.toISOString().slice(0, 10), site.timezone) / 1000
      )
    )
    const rows = await db.all<SourceLink>(sql`
      WITH matching_sources AS MATERIALIZED (${matchingSources}),
      eligible AS MATERIALIZED (
        SELECT v.referrer_url, v.landing_url FROM matching_sources s
        CROSS JOIN visits v INDEXED BY idx_visits_site_source_started
        WHERE v.site_id = ${site.id} AND v.source_id = s.id
          AND v.started_at >= ${start} AND v.started_at < ${end}
      ), referrers AS (
        SELECT referrer_url AS url, 'referrer' AS kind, COUNT(*) AS visits FROM eligible
        WHERE referrer_url IS NOT NULL AND length(referrer_url) <= ${MAX_RECORDED_URL_CHARS}
        GROUP BY referrer_url ORDER BY visits DESC, url LIMIT ${SOURCE_URLS_PER_KIND + 1}
      ), landings AS (
        SELECT landing_url AS url, 'landing' AS kind, COUNT(*) AS visits FROM eligible
        WHERE ${input.view === "utm" ? 1 : 0} = 1 AND landing_url IS NOT NULL AND length(landing_url) <= ${MAX_RECORDED_URL_CHARS}
        GROUP BY landing_url ORDER BY visits DESC, url LIMIT ${SOURCE_URLS_PER_KIND + 1}
      ) SELECT * FROM referrers UNION ALL SELECT * FROM landings
    `)
    const groups = (["referrer", "landing"] as const).map((kind) =>
      rows.filter((row) => row.kind === kind)
    )
    const links = groups
      .flatMap((group) => group.slice(0, SOURCE_URLS_PER_KIND))
      .map((row) => ({ ...row, visits: Number(row.visits) }))
    const details: SourceDetails = {
      ...selection!.details,
      links,
      linkCount: links.length,
      hasMore: groups.some((group) => group.length > SOURCE_URLS_PER_KIND),
      updatedAt: now,
    }
    await db
      .insert(sourceDetailsCache)
      .values({
        siteId: site.id,
        key,
        details,
        expiresAt: now + SOURCE_DETAILS_CACHE_SECONDS,
      })
      .onConflictDoUpdate({
        target: [sourceDetailsCache.siteId, sourceDetailsCache.key],
        set: { details, expiresAt: now + SOURCE_DETAILS_CACHE_SECONDS },
      })
    return details
  }
}
