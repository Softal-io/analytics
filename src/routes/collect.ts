import { createFileRoute } from "@tanstack/react-router"
import { env, waitUntil } from "cloudflare:workers"
import { and, eq, sql } from "drizzle-orm"
import type { CollectRequest } from "@/lib/collect-schema"
import type { GeoInfo } from "@/lib/geo"
import { db } from "@/db"
import { sites, trackingContexts, visitors } from "@/db/schema"
import { collectRequestSchema } from "@/lib/collect-schema"
import { extractGeo } from "@/lib/geo"
import {
  parseReferrer,
  resolveDeviceId,
  resolveLocationId,
  resolveSourceId,
} from "@/lib/lookups"
import {
  hashReportKey,
  reconcileVisits,
  recordPage,
  resolvePage,
} from "@/lib/session"
import { runBatch } from "@/lib/d1-batch"
import { invalidateReportingDay } from "@/lib/reporting-slices"
import { parseUserAgent } from "@/lib/ua"
import { computeVisitorId } from "@/lib/visitor-id"
import { recordEngagement, recordInteraction } from "@/lib/engagement"
import { OMITTED_OUTBOUND_URL } from "@/lib/analytics-config"
import { recordedUrl } from "@/lib/recorded-url"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

const MAX_COLLECT_BODY_BYTES = 48 * 1024

/**
 * `POST /collect` — the only public route (§8, §10). Called by the
 * tracking snippet (`public/script.js`) via `fetch`/`sendBeacon`.
 *
 * Acknowledges a report only after persistence. Browsers can safely retry transient
 * failures; page and action IDs make repeats idempotent.
 */
export const Route = createFileRoute("/collect")({
  server: {
    handlers: {
      POST: ({ request }) => handleCollectRequest(request),

      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
    },
  },
})

export async function handleCollectRequest(
  request: Request
): Promise<Response> {
  const raw = await readBody(request)
  const parsed = collectRequestSchema.safeParse(raw)

  if (!parsed.success)
    return new Response(null, { status: 400, headers: CORS_HEADERS })
  try {
    const accepted = await processCollectRequest(parsed.data, {
      ip: request.headers.get("CF-Connecting-IP") ?? "0.0.0.0",
      userAgent: request.headers.get("User-Agent") ?? "",
      geo: extractGeo(request),
      now: Date.now(),
    })
    return new Response(null, {
      status: accepted ? 204 : 400,
      headers: CORS_HEADERS,
    })
  } catch (error) {
    console.error(
      "Analytics ingestion failed",
      error instanceof Error ? error.message : "Unknown error"
    )
    return new Response(null, { status: 503, headers: CORS_HEADERS })
  }
}

async function readBody(request: Request): Promise<unknown> {
  // `navigator.sendBeacon` sends `Content-Type: text/plain`, so we read as
  // text and parse ourselves rather than relying on `request.json()`.
  try {
    const contentLength = request.headers.get("Content-Length")
    if (contentLength && Number(contentLength) > MAX_COLLECT_BODY_BYTES) {
      return null
    }

    if (!request.body) return null

    const reader = request.body.getReader()
    const decoder = new TextDecoder()
    let totalBytes = 0
    let text = ""

    let chunk = await reader.read()
    while (!chunk.done) {
      const { value } = chunk
      totalBytes += value.byteLength
      if (totalBytes > MAX_COLLECT_BODY_BYTES) {
        await reader.cancel()
        return null
      }

      text += decoder.decode(value, { stream: true })
      chunk = await reader.read()
    }

    text += decoder.decode()
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

interface CollectContext {
  ip: string
  userAgent: string
  geo: GeoInfo
  now: number
}

export async function processCollectRequest(
  data: CollectRequest,
  ctx: CollectContext
): Promise<boolean> {
  const site = await db
    .select()
    .from(sites)
    .where(eq(sites.id, data.site_id))
    .limit(1)
    .get()
  if (!site) return false

  let visitorId = await computeVisitorId(site.id, ctx.ip, ctx.userAgent)
  let trackedPage = data.page_id
    ? await resolvePage(site.id, data.page_id)
    : undefined
  const reportKeyHash =
    data.version === 2 ? await hashReportKey(data.page_key!) : undefined
  if (data.version === 2) {
    const page = trackedPage
    if (page) {
      if (page.reportKeyHash !== reportKeyHash) return false
      visitorId = page.visitorId
    } else if (data.previous_page_id && data.previous_page_key) {
      const previous = await resolvePage(site.id, data.previous_page_id)
      if (
        previous?.reportKeyHash ===
        (await hashReportKey(data.previous_page_key))
      )
        visitorId = previous.visitorId
    }
  }
  const nowSec = Math.floor(ctx.now / 1000)

  if (data.version === 2 && data.context_key) {
    const keyHash = await hashReportKey(data.context_key)
    // Establish the mapping and its FK together. Concurrent first reports use
    // whichever mapping committed first, even if their network identities differ.
    await runBatch([
      sql`INSERT INTO visitors (id, site_id, first_seen, last_seen)
        SELECT ${visitorId}, ${site.id}, ${nowSec}, ${nowSec}
        WHERE NOT EXISTS (SELECT 1 FROM tracking_contexts WHERE site_id = ${site.id} AND key_hash = ${keyHash})
        ON CONFLICT (id) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)`,
      sql`INSERT INTO tracking_contexts (site_id, key_hash, visitor_id, last_seen) VALUES (${site.id}, ${keyHash}, ${visitorId}, ${nowSec})
        ON CONFLICT (site_id, key_hash) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)`,
    ])
    const context = await db
      .select({ visitorId: trackingContexts.visitorId })
      .from(trackingContexts)
      .where(
        and(
          eq(trackingContexts.siteId, site.id),
          eq(trackingContexts.keyHash, keyHash)
        )
      )
      .get()
    if (!context) throw new Error("Tracking context was not persisted")
    visitorId = context.visitorId
  }

  await db
    .insert(visitors)
    .values({
      id: visitorId,
      siteId: site.id,
      firstSeen: nowSec,
      lastSeen: nowSec,
    })
    .onConflictDoUpdate({
      target: visitors.id,
      set: { lastSeen: sql`MAX(${visitors.lastSeen}, ${nowSec})` },
    })

  if (data.version === 2) {
    if (!trackedPage)
      await handlePageview(site, visitorId, data, ctx, reportKeyHash)
    // Another report might have won the first-page insert while lookups ran.
    trackedPage ??= await resolvePage(site.id, data.page_id!)
    const page = trackedPage
    if (!page || page.reportKeyHash !== reportKeyHash) return false
    visitorId = page.visitorId
    const activitySec = Math.floor(
      Math.min(
        ctx.now,
        (page.timestampMs ?? page.timestamp * 1000) + data.activity_ms!
      ) / 1000
    )
    await recordEngagement(
      site.id,
      visitorId,
      data.page_id!,
      data.duration_ms!,
      nowSec,
      {
        elapsedMs: data.elapsed_ms!,
        activityMs: data.activity_ms!,
        reportKeyHash: reportKeyHash,
      }
    )
    if (data.kind === "outbound")
      await handleOutboundLink(
        site,
        visitorId,
        data.outbound_url!,
        activitySec,
        data.page_id,
        data.event_id
      )
    if (data.kind === "event")
      await handleEvent(site.id, visitorId, data, activitySec)
    pingRecentVisitor(site.id, visitorId, ctx.geo, activitySec * 1000)
  } else {
    if (data.path && !data.name && !data.outbound_url)
      await handlePageview(site, visitorId, data, ctx)
    if (data.page_id && data.duration_ms !== undefined) {
      if (
        await recordEngagement(
          site.id,
          visitorId,
          data.page_id,
          data.duration_ms,
          nowSec
        )
      )
        pingRecentVisitor(site.id, visitorId, ctx.geo)
    }
    if (data.outbound_url)
      await handleOutboundLink(
        site,
        visitorId,
        data.outbound_url,
        nowSec,
        data.page_id
      )
    else if (data.name) await handleEvent(site.id, visitorId, data, nowSec)
  }
  return true
}

async function handleOutboundLink(
  site: typeof sites.$inferSelect,
  visitorId: string,
  value: string,
  nowSec: number,
  pageId?: string,
  eventId?: string
): Promise<void> {
  const url = normalizeOutboundUrl(value, site.domain)
  if (!url) return

  const page = pageId ? await resolvePage(site.id, pageId) : undefined
  const visitId =
    page?.visitorId === visitorId
      ? page.visitId
      : await recordInteraction(site.id, visitorId, nowSec, pageId)
  const currentVisit =
    page?.visitorId === visitorId
      ? sql`(SELECT visit_id FROM pages WHERE id = ${page.id})`
      : sql`${visitId ?? ""}`
  await runBatch([
    sql`INSERT INTO outbound_links (site_id, visitor_id, url, timestamp, tracking_id) VALUES (${site.id}, ${visitorId}, ${url}, ${nowSec}, ${eventId ?? null}) ON CONFLICT (site_id, tracking_id) DO NOTHING`,
    sql`UPDATE visits SET is_bounce = 0, ended_at = MAX(ended_at, ${nowSec}) WHERE id = ${currentVisit} AND changes() > 0`,
    invalidateReportingDay(site.id, nowSec, visitId ?? undefined, page?.id),
    ...(pageId ? reconcileVisits(site.id, pageId) : []),
  ])
}

export function normalizeOutboundUrl(
  value: string,
  siteDomain: string
): string | null {
  if (value === OMITTED_OUTBOUND_URL) return value
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null

    const siteUrl = new URL(
      siteDomain.includes("://") ? siteDomain : `https://${siteDomain}`
    )
    if (
      url.hostname.replace(/^www\./, "") ===
      siteUrl.hostname.replace(/^www\./, "")
    ) {
      return null
    }

    return recordedUrl(url.href) ?? OMITTED_OUTBOUND_URL
  } catch {
    return null
  }
}

async function handlePageview(
  site: typeof sites.$inferSelect,
  visitorId: string,
  data: CollectRequest,
  ctx: CollectContext,
  reportKeyHash?: string
): Promise<void> {
  if (!data.path) return

  const parsedUa = parseUserAgent(ctx.userAgent)
  const referrer = parseReferrer(data.referrer, site.domain, {
    utmSource: data.utm_source,
    utmMedium: data.utm_medium,
    utmCampaign: data.utm_campaign,
  })

  const [sourceId, deviceId, locationId] = await Promise.all([
    resolveSourceId(site.id, referrer),
    resolveDeviceId(parsedUa),
    resolveLocationId(ctx.geo),
  ])

  await recordPage({
    siteId: site.id,
    visitorId,
    path: data.path,
    timestampMs: pageTimestamp(data, ctx.now),
    sourceId,
    referrerUrl: referrer.referrerDomain.startsWith("(")
      ? null
      : (recordedUrl(data.referrer) ?? null),
    landingUrl: data.page_url
      ? normalizeLandingUrl(data.page_url, site.domain)
      : null,
    deviceId,
    locationId,
    measureDuration: Boolean(data.page_id),
    pageId: data.page_id,
    reportKeyHash,
    title: data.title,
  })

  if (data.version !== 2) pingRecentVisitor(site.id, visitorId, ctx.geo)
}

/** Preserve event order across transit delays without trusting implausible device clocks. */
function pageTimestamp(data: CollectRequest, now: number): number {
  if (data.version !== 2) return now
  const elapsedMs = data.elapsed_ms!
  const startedAt = data.page_started_at_ms
  if (startedAt !== undefined) {
    const transitMs = now - (startedAt + elapsedMs)
    if (
      startedAt <= now &&
      startedAt >= now - 2 * 86400000 &&
      Math.abs(transitMs) <= 60000
    )
      return startedAt
  }
  // Old snippets and clocks more than a minute out retain server-relative timing.
  return now - elapsedMs
}

export function normalizeLandingUrl(
  value: string,
  siteDomain: string
): string | null {
  const href = recordedUrl(value)
  if (!href) return null
  try {
    const siteUrl = new URL(
      siteDomain.includes("://") ? siteDomain : `https://${siteDomain}`
    )
    return new URL(href).hostname.replace(/^www\./, "") ===
      siteUrl.hostname.replace(/^www\./, "")
      ? href
      : null
  } catch {
    return null
  }
}

function pingRecentVisitor(
  siteId: string,
  visitorId: string,
  geo: GeoInfo,
  seenAt = Date.now()
) {
  // Fire-and-forget ping to the site's LiveVisitors DO (§11). Never let a
  // DO hiccup affect ingestion.
  const stub = env.LIVE_VISITORS.getByName(siteId)
  const realtimeLocation =
    geo.latitude !== null && geo.longitude !== null
      ? {
          latitude: geo.latitude,
          longitude: geo.longitude,
        }
      : undefined
  waitUntil(
    stub.ping(visitorId, realtimeLocation, seenAt).then(
      () => undefined,
      () => undefined
    )
  )
}

async function handleEvent(
  siteId: string,
  visitorId: string,
  data: CollectRequest,
  nowSec: number
): Promise<void> {
  if (!data.name) return

  const page = data.page_id
    ? await resolvePage(siteId, data.page_id)
    : undefined
  const visitId =
    page?.visitorId === visitorId
      ? page.visitId
      : await recordInteraction(siteId, visitorId, nowSec, data.page_id)
  if (!visitId) return
  const currentVisit =
    page?.visitorId === visitorId
      ? sql`(SELECT visit_id FROM pages WHERE id = ${page.id})`
      : sql`${visitId}`
  await runBatch([
    sql`INSERT INTO events (site_id, visit_id, name, props, timestamp, tracking_id)
      VALUES (${siteId}, ${currentVisit}, ${data.name}, ${data.props ? JSON.stringify(data.props) : null}, ${nowSec}, ${data.event_id ?? null})
      ON CONFLICT (site_id, tracking_id) DO NOTHING`,
    sql`UPDATE visits SET is_bounce = 0, ended_at = MAX(ended_at, ${nowSec}) WHERE id = ${currentVisit} AND changes() > 0`,
    invalidateReportingDay(siteId, nowSec, visitId, page?.id),
    ...(data.page_id ? reconcileVisits(siteId, data.page_id) : []),
  ])
}
