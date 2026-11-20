import { createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { processCollectRequest } from "../routes/collect"
import { Route as polarWebhook } from "../routes/api/webhooks.polar"
import { mockD1, openTestDatabase } from "../test/d1"
import { aggregateSiteDay } from "./aggregate"
import { collectRequestSchema } from "./collect-schema"
import { previousRange, resolveRange } from "./dates"
import {
  computePayments,
  parseAttributionReference,
  polarOrder,
  recordOrder,
  verifyWebhookSignature,
} from "./payments"
import { computePreviousSummary, computeSummary } from "./summary"
import { computeTimeseries } from "./timeseries"
import {
  computeEventList,
  computeTopDevices,
  computeTopLocations,
  computeTopPages,
  computeTopSources,
} from "./top-lists"
import { parseVisitFilters } from "./visit-filter-schema"
import type { DatabaseSync } from "node:sqlite"
import type { CollectRequest } from "./collect-schema"

const d1 = vi.hoisted(() => ({ prepare: vi.fn(), batch: vi.fn() }))
const secrets = vi.hoisted(() => ({ polar: undefined as string | undefined }))
vi.mock("cloudflare:workers", () => ({
  env: {
    DB: d1,
    get POLAR_WEBHOOK_SECRET() {
      return secrets.polar
    },
    LIVE_VISITORS: { getByName: () => ({ ping: () => Promise.resolve(1) }) },
  },
  waitUntil: (promise: Promise<unknown>) => {
    void promise
  },
}))

let database: DatabaseSync
const site = {
  id: "site",
  name: "Fixture",
  domain: "fixture.example",
  timezone: "UTC",
  createdAt: 0,
}
const now = Date.parse("2026-09-03T12:00:00Z")
const today = {
  fromDate: "2026-09-03",
  toDate: "2026-09-03",
  today: "2026-09-03",
}
const week = {
  fromDate: "2026-08-28",
  toDate: "2026-09-03",
  today: "2026-09-03",
}
const chrome =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
const iphone =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1"

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(now))
  database = openTestDatabase()
  mockD1(d1, () => database)
  database
    .prepare("INSERT INTO sites VALUES (?, ?, ?, ?, ?)")
    .run(site.id, site.name, site.domain, site.timezone, 0)
})
afterEach(() => {
  database.close()
  vi.useRealTimers()
})

let sequence = 0
function uuid() {
  return `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
}

interface Visitor {
  ip: string
  userAgent: string
  country: string
  city?: string
}
const mac: Visitor = {
  ip: "1.1.1.1",
  userAgent: chrome,
  country: "US",
  city: "Austin",
}
const phone: Visitor = {
  ip: "2.2.2.2",
  userAgent: iphone,
  country: "IN",
  city: "Pune",
}

/** One recorded page, with the optional click or event made on it. */
async function view(
  visitor: Visitor,
  atMs: number,
  page: Partial<CollectRequest> = {},
  action?: Partial<CollectRequest>
) {
  const base = {
    version: 2 as const,
    site_id: site.id,
    context_key: uuid(),
    page_id: uuid(),
    page_key: uuid(),
    path: "/",
    page_started_at_ms: atMs,
    elapsed_ms: 0,
    activity_ms: 0,
    duration_ms: 0,
    ...page,
  }
  const context = (at: number) => ({
    ip: visitor.ip,
    userAgent: visitor.userAgent,
    geo: {
      country: visitor.country,
      region: null,
      city: visitor.city ?? null,
      latitude: null,
      longitude: null,
    },
    now: at,
  })
  const send = async (data: Record<string, unknown>, at: number) =>
    expect(
      await processCollectRequest(collectRequestSchema.parse(data), context(at))
    ).toBe(true)
  await send({ ...base, kind: "page" }, atMs)
  if (action)
    await send(
      {
        ...base,
        ...action,
        event_id: uuid(),
        elapsed_ms: 2000,
        activity_ms: 2000,
        duration_ms: 2000,
      },
      atMs + 2000
    )
  return base.page_id
}

const morning = now - 3 * 3600_000

describe("visit filters", () => {
  async function traffic() {
    const pricing = await view(
      mac,
      morning,
      { path: "/pricing", referrer: "https://news.ycombinator.com/item?id=1" },
      { kind: "outbound", outbound_url: "https://buy.polar.sh/polar_cl_x" }
    )
    await view(
      phone,
      morning + 60_000,
      { path: "/", referrer: "https://www.google.com/", utm_source: "ads" },
      { kind: "event", name: "signup" }
    )
    await view(phone, morning + 120_000, { path: "/docs" })
    return pricing
  }

  it("narrows every report to the visits that match", async () => {
    await traffic()
    expect(await computeSummary(site, today)).toMatchObject({
      visitors: 2,
      visits: 2,
      pageviews: 3,
    })
    const page = { page: "/pricing" }
    expect(await computeSummary(site, today, undefined, page)).toMatchObject({
      visitors: 1,
      visits: 1,
      pageviews: 1,
    })
    expect(
      (await computeTopSources(site, today, "referrer", 10, undefined, page))
        .rows
    ).toMatchObject([{ key: "news.ycombinator.com", visits: 1 }])
    expect(
      (await computeTopDevices(site, today, "device", 10, undefined, page)).rows
    ).toEqual([{ value: "desktop", visits: 1 }])
    expect(
      (await computeTopLocations(site, today, "city", 10, undefined, page)).rows
    ).toMatchObject([{ country: "US", city: "Austin", visits: 1 }])
    expect(
      (await computeTopSources(site, today, "links", 10, undefined, page)).rows
    ).toMatchObject([{ key: "https://buy.polar.sh/polar_cl_x", visits: 1 }])
    expect(
      (await computeEventList(site, today, 10, undefined, page)).rows
    ).toEqual([])

    // A visit filter shows everything those visits did, not just the match.
    const india = { country: "IN" }
    expect(
      (await computeTopPages(site, today, "top", 10, undefined, india)).rows
    ).toEqual([
      { path: "/", count: 1 },
      { path: "/docs", count: 1 },
    ])
    expect(
      (await computeEventList(site, today, 10, undefined, india)).rows
    ).toEqual([{ name: "signup", count: 1 }])
    expect(
      (await computeTopSources(site, today, "links", 10, undefined, india)).rows
    ).toEqual([])
  })

  it("filters by outbound link, event, campaign, and entry page", async () => {
    await traffic()
    const visits = async (filters: Record<string, string>) =>
      (await computeSummary(site, today, undefined, filters)).visits
    expect(await visits({ link: "https://buy.polar.sh/polar_cl_x" })).toBe(1)
    expect(await visits({ link: "https://elsewhere.example/" })).toBe(0)
    expect(await visits({ event: "signup" })).toBe(1)
    expect(await visits({ utm: JSON.stringify(["ads", "", ""]) })).toBe(1)
    expect(await visits({ entry: "/" })).toBe(1)
    expect(await visits({ exit: "/docs" })).toBe(1)
    expect(await visits({ browser: "Chrome", country: "IN" })).toBe(0)
    expect(await visits({ referrer: "google.com", device: "mobile" })).toBe(1)
  })

  it("reads raw records for a filtered report even when the day is rolled up", async () => {
    vi.setSystemTime(new Date(now - 86400_000))
    await view(mac, now - 86400_000 - 3600_000, { path: "/pricing" })
    await view(phone, now - 86400_000 - 1800_000, { path: "/" })
    vi.setSystemTime(new Date(now))
    await aggregateSiteDay(site.id, site.timezone, "2026-09-02")
    expect((await computeSummary(site, week)).visits).toBe(2)
    expect(
      (await computeSummary(site, week, undefined, { country: "US" })).visits
    ).toBe(1)
    const points = await computeTimeseries(site, week, undefined, {
      country: "US",
    })
    expect(points.map((point) => point.pageviews)).toEqual([
      0, 0, 0, 0, 0, 1, 0,
    ])
    expect(points.map((point) => point.visitors)).toEqual([0, 0, 0, 0, 0, 1, 0])
  })

  it("rejects an unusable filter instead of reporting unfiltered numbers", () => {
    expect(parseVisitFilters(new URLSearchParams("range=7d"))).toBeUndefined()
    expect(parseVisitFilters(new URLSearchParams("country=US"))).toEqual({
      country: "US",
    })
    expect(parseVisitFilters(new URLSearchParams("utm=nonsense"))).toBeNull()
    expect(parseVisitFilters(new URLSearchParams("paid=yes"))).toBeNull()
  })

  it("returns as many rows as requested, so every outbound link can be listed", async () => {
    for (let index = 0; index < 14; index++)
      await view(
        mac,
        morning + index * 1000,
        {},
        {
          kind: "outbound",
          outbound_url: `https://vendor${index}.example/?utm_source=fixture`,
        }
      )
    expect((await computeTopSources(site, today, "links")).rows).toHaveLength(
      10
    )
    const all = await computeTopSources(site, today, "links", 100)
    expect(all.rows).toHaveLength(14)
    expect(all.total).toBe(14)
  })
})

describe("date ranges and comparison", () => {
  it("resolves yesterday and charts it by the hour", async () => {
    expect(resolveRange("yesterday", "UTC")).toEqual({
      fromDate: "2026-09-02",
      toDate: "2026-09-02",
      today: "2026-09-03",
    })
    vi.setSystemTime(new Date(now - 86400_000))
    await view(mac, Date.parse("2026-09-02T09:30:00Z"))
    vi.setSystemTime(new Date(now))
    const points = await computeTimeseries(
      site,
      resolveRange("yesterday", "UTC")
    )
    expect(points).toHaveLength(24)
    expect(points[9]).toMatchObject({ pageviews: 1, visitors: 1 })
  })

  it("compares a range in progress with the earlier period up to the same time", () => {
    expect(previousRange(today, "UTC", now)).toEqual({
      resolved: {
        fromDate: "2026-09-02",
        toDate: "2026-09-02",
        today: "2026-09-03",
      },
      untilSec: Date.parse("2026-09-02T12:00:00Z") / 1000,
    })
    expect(previousRange(week, "UTC", now)).toEqual({
      resolved: {
        fromDate: "2026-08-21",
        toDate: "2026-08-27",
        today: "2026-09-03",
      },
      untilSec: Date.parse("2026-08-27T12:00:00Z") / 1000,
    })
    // A finished range is compared with whole days.
    expect(previousRange(resolveRange("yesterday", "UTC"), "UTC", now)).toEqual(
      {
        resolved: {
          fromDate: "2026-09-01",
          toDate: "2026-09-01",
          today: "2026-09-03",
        },
      }
    )
  })

  it("leaves out visits from later in the earlier day", async () => {
    vi.setSystemTime(new Date(now - 86400_000 + 6 * 3600_000))
    await view(mac, Date.parse("2026-09-02T08:00:00Z"))
    await view(phone, Date.parse("2026-09-02T17:00:00Z"))
    vi.setSystemTime(new Date(now))
    await view(mac, morning)
    expect(await computeSummary(site, today)).toMatchObject({ visits: 1 })
    expect(await computePreviousSummary(site, today)).toMatchObject({
      visits: 1,
      visitors: 1,
      pageviews: 1,
      range: { fromDate: "2026-09-02", toDate: "2026-09-02" },
    })
    // Rolling the earlier day up must not bring its afternoon back.
    await aggregateSiteDay(site.id, site.timezone, "2026-09-02")
    expect((await computePreviousSummary(site, today)).visits).toBe(1)
    expect(
      (await computePreviousSummary(site, resolveRange("7d", "UTC"))).visits
    ).toBe(0)
  })

  it("ignores custom ranges that are malformed or unbounded", () => {
    const fallback = { fromDate: "2026-09-03", toDate: "2026-09-03" }
    expect(
      resolveRange("custom", "UTC", "0001-01-01", "9999-12-31")
    ).toMatchObject(fallback)
    expect(
      resolveRange("custom", "UTC", "2026-02-31", "2026-03-02")
    ).toMatchObject(fallback)
    expect(
      resolveRange("custom", "UTC", "1 OR 1=1", "2026-03-02")
    ).toMatchObject(fallback)
    expect(
      resolveRange("custom", "UTC", "2026-08-01", "2026-12-31")
    ).toMatchObject({ fromDate: "2026-08-01", toDate: "2026-09-03" })
  })
})

describe("ingestion tolerance", () => {
  it("accepts visible time one millisecond past the last activity", () => {
    const report = {
      version: 2,
      kind: "outbound",
      site_id: site.id,
      page_id: uuid(),
      page_key: uuid(),
      event_id: uuid(),
      path: "/",
      outbound_url: "https://vendor.example/",
      elapsed_ms: 30000,
      activity_ms: 29999,
    }
    expect(
      collectRequestSchema.safeParse({ ...report, duration_ms: 30000 }).success
    ).toBe(true)
    expect(
      collectRequestSchema.safeParse({ ...report, duration_ms: 30002 }).success
    ).toBe(false)
  })
})

describe("payments", () => {
  const order = (reference: string | undefined, overrides = {}) => ({
    provider: "polar" as const,
    orderId: "order_1",
    amount: 4900,
    refundedAmount: 0,
    currency: "USD",
    product: "Presentify",
    reference,
    reportedAt: now / 1000,
    createdAt: now / 1000,
    ...overrides,
  })

  it("attributes an order to the visit that opened the checkout", async () => {
    const pageId = await view(
      mac,
      morning,
      { path: "/pricing", referrer: "https://news.ycombinator.com/item?id=1" },
      { kind: "outbound", outbound_url: "https://buy.polar.sh/polar_cl_x" }
    )
    await view(phone, morning + 60_000, { path: "/" })
    expect(await recordOrder(order(`wa.site.${pageId}`))).toBe("recorded")
    // A repeated delivery changes nothing.
    await recordOrder(order(`wa.site.${pageId}`))

    const result = await computePayments(site, today)
    expect(result).toMatchObject({
      payments: 1,
      paidVisits: 1,
      totals: [{ currency: "usd", revenue: 4900, payments: 1 }],
    })
    expect(result.rows[0]).toMatchObject({
      attributed: true,
      product: "Presentify",
      path: "/pricing",
      entryPage: "/pricing",
      referrerDomain: "news.ycombinator.com",
      country: "US",
    })

    // Following the payment back: who paid, and from where.
    const paid = { paid: "1" as const }
    expect(await computeSummary(site, today, undefined, paid)).toMatchObject({
      visits: 1,
      visitors: 1,
    })
    expect(
      (await computeTopSources(site, today, "referrer", 10, undefined, paid))
        .rows
    ).toMatchObject([{ key: "news.ycombinator.com", visits: 1 }])
    // And forward: did visits from this source or link pay?
    expect(
      (await computePayments(site, today, { referrer: "news.ycombinator.com" }))
        .payments
    ).toBe(1)
    expect(
      (
        await computePayments(site, today, {
          link: "https://buy.polar.sh/polar_cl_x",
        })
      ).payments
    ).toBe(1)
    expect(
      (await computePayments(site, today, { country: "IN" })).payments
    ).toBe(0)
  })

  it("applies refunds and ignores an older report that arrives late", async () => {
    const pageId = await view(mac, morning)
    const reference = `wa.site.${pageId}`
    await recordOrder(order(reference))
    await recordOrder(
      order(reference, {
        refundedAmount: 4900,
        reportedAt: now / 1000 + 60,
      })
    )
    await recordOrder(order(reference, { reportedAt: now / 1000 - 60 }))
    expect(await computePayments(site, today)).toMatchObject({
      payments: 0,
      paidVisits: 0,
      totals: [{ revenue: 0, payments: 0 }],
    })
    expect(
      (await computeSummary(site, today, undefined, { paid: "1" })).visits
    ).toBe(0)
  })

  it("keeps an order without a usable reference out of every website unless one is named", async () => {
    expect(await recordOrder(order(undefined))).toBe("unattributed")
    expect(await recordOrder(order("wa.missing-site." + uuid()))).toBe(
      "unattributed"
    )
    expect(await recordOrder(order(undefined), site.id)).toBe("recorded")
    const result = await computePayments(site, today)
    expect(result).toMatchObject({ payments: 1, paidVisits: 0 })
    expect(result.rows[0].attributed).toBe(false)
  })

  it("reads the reference and net amount from a Polar order event", () => {
    const pageId = uuid()
    const event = {
      type: "order.paid",
      timestamp: "2026-09-03T11:00:00Z",
      data: {
        id: "ord_1",
        created_at: "2026-09-03T10:59:00Z",
        status: "paid",
        paid: true,
        currency: "usd",
        subtotal_amount: 4900,
        discount_amount: 900,
        net_amount: 4000,
        tax_amount: 800,
        total_amount: 4800,
        refunded_amount: 0,
        billing_reason: "purchase",
        metadata: { reference_id: `wa.site.${pageId}`, utm_source: "x" },
        product: { name: "Presentify" },
        customer: { email: "someone@example.com" },
      },
    }
    expect(polarOrder(event, now / 1000)).toEqual({
      provider: "polar",
      orderId: "ord_1",
      amount: 4000,
      refundedAmount: 0,
      currency: "usd",
      product: "Presentify",
      billingReason: "purchase",
      reference: `wa.site.${pageId}`,
      reportedAt: Date.parse("2026-09-03T11:00:00Z") / 1000,
      createdAt: Date.parse("2026-09-03T10:59:00Z") / 1000,
    })
    expect(
      polarOrder(
        {
          ...event,
          type: "order.created",
          data: { ...event.data, status: "pending", paid: false },
        },
        0
      )
    ).toBeUndefined()
    expect(
      polarOrder({ type: "checkout.updated", data: { id: "x" } }, 0)
    ).toBeUndefined()
    expect(
      polarOrder(
        {
          ...event,
          type: "order.refunded",
          data: { ...event.data, status: "refunded" },
        },
        0
      )
    ).toMatchObject({ refundedAmount: 4000 })
    expect(parseAttributionReference("wa.site.not-a-page")).toBeUndefined()
  })

  it("accepts only correctly signed, recent webhooks", async () => {
    const body = JSON.stringify({ type: "order.paid" })
    const nowSec = now / 1000
    const sign = (key: Buffer | string, timestamp = nowSec) =>
      new Headers({
        "webhook-id": "msg_1",
        "webhook-timestamp": String(timestamp),
        "webhook-signature": `v1,${createHmac("sha256", key)
          .update(`msg_1.${timestamp}.${body}`)
          .digest("base64")}`,
      })
    const raw = Buffer.from("a-32-byte-signing-key-for-tests!")
    const secret = `whsec_${raw.toString("base64")}`
    // Standard Webhooks: the key is the decoded secret.
    expect(
      await verifyWebhookSignature(body, sign(raw), [secret], nowSec)
    ).toBe(true)
    // Endpoints created before September 2026 sign with the secret's text.
    expect(
      await verifyWebhookSignature(body, sign(secret), [secret], nowSec)
    ).toBe(true)
    expect(
      await verifyWebhookSignature(
        body,
        sign(raw),
        ["whsec_other", secret],
        nowSec
      )
    ).toBe(true)
    expect(
      await verifyWebhookSignature(body + " ", sign(raw), [secret], nowSec)
    ).toBe(false)
    expect(
      await verifyWebhookSignature(body, sign("wrong"), [secret], nowSec)
    ).toBe(false)
    expect(
      await verifyWebhookSignature(
        body,
        sign(raw, nowSec - 3600),
        [secret],
        nowSec
      )
    ).toBe(false)
    expect(
      await verifyWebhookSignature(body, new Headers(), [secret], nowSec)
    ).toBe(false)
  })

  it("records a signed Polar order end to end and refuses everything else", async () => {
    const pageId = await view(
      mac,
      morning,
      { path: "/pricing", referrer: "https://news.ycombinator.com/item?id=1" },
      { kind: "outbound", outbound_url: "https://buy.polar.sh/polar_cl_x" }
    )
    const key = Buffer.from("a-32-byte-signing-key-for-tests!")
    const body = JSON.stringify({
      type: "order.paid",
      timestamp: new Date(now).toISOString(),
      data: {
        id: "ord_live",
        created_at: new Date(now).toISOString(),
        status: "paid",
        paid: true,
        currency: "usd",
        net_amount: 4900,
        tax_amount: 980,
        total_amount: 5880,
        billing_reason: "purchase",
        metadata: { reference_id: `wa.site.${pageId}` },
        product: { name: "Presentify" },
      },
    })
    const post = (signedWith: Buffer, payload = body) => {
      const timestamp = String(now / 1000)
      const handler = polarWebhook.options.server!.handlers as {
        POST: (context: { request: Request }) => Promise<Response>
      }
      return handler.POST({
        request: new Request("https://analytics.example/api/webhooks/polar", {
          method: "POST",
          body: payload,
          headers: {
            "webhook-id": "msg_1",
            "webhook-timestamp": timestamp,
            "webhook-signature": `v1,${createHmac("sha256", signedWith)
              .update(`msg_1.${timestamp}.${payload}`)
              .digest("base64")}`,
          },
        }),
      })
    }
    // Switched off until a secret is configured.
    secrets.polar = undefined
    expect((await post(key)).status).toBe(503)
    secrets.polar = `whsec_${key.toString("base64")}`
    expect((await post(Buffer.from("forged"))).status).toBe(403)
    expect((await computePayments(site, today)).payments).toBe(0)

    const accepted = await post(key)
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ status: "recorded" })
    expect((await post(key)).status).toBe(202)
    const result = await computePayments(site, today)
    expect(result).toMatchObject({
      payments: 1,
      totals: [{ currency: "usd", revenue: 4900 }],
    })
    expect(result.rows[0]).toMatchObject({
      attributed: true,
      path: "/pricing",
      referrerDomain: "news.ycombinator.com",
    })
    // Events that are not settled orders are acknowledged and ignored.
    const other = JSON.stringify({
      type: "checkout.created",
      data: { id: "c" },
    })
    const ignored = await post(key, other)
    expect(ignored.status).toBe(202)
    expect(await ignored.json()).toEqual({ status: "ignored" })
    secrets.polar = undefined
  })
})
