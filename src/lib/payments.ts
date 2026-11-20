import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { shiftDate, startOfDayUtcMs } from "./dates"
import { visitsFilter } from "./visit-filters"
import type { ResolvedRange } from "./dates"
import type { VisitFilters } from "./visit-filter-schema"
import type { Site } from "@/db/schema"
import { db } from "@/db"
import { pages, sites } from "@/db/schema"

/**
 * Payment attribution.
 *
 * The tracker adds `reference_id=wa.<site>.<page>` to checkout links. The
 * provider returns that reference with the paid order, which ties the order
 * to the page the visitor was on, and through it to the visit's source,
 * device, location and pages. Providers share this storage and reporting;
 * each one only needs to verify its webhook and map its order to `OrderInput`.
 */
const REFERENCE = /^wa\.([A-Za-z0-9_-]{1,64})\.([0-9a-f-]{36})$/

export function parseAttributionReference(
  value: unknown
): { siteId: string; pageId: string; reference: string } | undefined {
  if (typeof value !== "string") return undefined
  const match = REFERENCE.exec(value.trim())
  return match
    ? { siteId: match[1], pageId: match[2], reference: match[0] }
    : undefined
}

export interface OrderInput {
  provider: "polar"
  orderId: string
  /** Minor units, excluding tax. */
  amount: number
  refundedAmount: number
  currency: string
  product?: string
  billingReason?: string
  reference?: string
  /** When the provider reported this state, in seconds. */
  reportedAt: number
  /** When the provider created the order, in seconds. */
  createdAt: number
}

export type RecordOrderResult = "recorded" | "unattributed"

/**
 * Stores or updates one order. Reports can arrive repeatedly and out of
 * order: an older report never replaces a newer state. An order is dated by
 * its creation, which every report of it agrees on.
 */
export async function recordOrder(
  order: OrderInput,
  fallbackSiteId?: string
): Promise<RecordOrderResult> {
  const reference = parseAttributionReference(order.reference)
  const siteId = reference?.siteId ?? fallbackSiteId
  if (!siteId) return "unattributed"
  const site = await db
    .select({ id: sites.id })
    .from(sites)
    .where(eq(sites.id, siteId))
    .get()
  if (!site) return "unattributed"
  const page = reference
    ? await db
        .select({ id: pages.id })
        .from(pages)
        .where(
          and(eq(pages.siteId, site.id), eq(pages.trackingId, reference.pageId))
        )
        .get()
    : undefined
  const refunded = Math.min(order.amount, Math.max(0, order.refundedAmount))
  const status =
    refunded <= 0
      ? "paid"
      : refunded >= order.amount
        ? "refunded"
        : "partially_refunded"
  await db.run(sql`INSERT INTO payments (site_id, provider, order_id, page_id, reference, amount,
      refunded_amount, currency, status, product, billing_reason, paid_at, updated_at)
    VALUES (${site.id}, ${order.provider}, ${order.orderId}, ${page?.id ?? null},
      ${reference?.reference ?? null}, ${order.amount}, ${refunded}, ${order.currency.toLowerCase()},
      ${status}, ${order.product?.slice(0, 300) ?? null}, ${order.billingReason?.slice(0, 100) ?? null},
      ${order.createdAt}, ${order.reportedAt})
    ON CONFLICT (provider, order_id) DO UPDATE SET
      amount = excluded.amount, refunded_amount = excluded.refunded_amount,
      currency = excluded.currency, status = excluded.status,
      product = COALESCE(excluded.product, payments.product),
      billing_reason = COALESCE(excluded.billing_reason, payments.billing_reason),
      page_id = COALESCE(payments.page_id, excluded.page_id),
      reference = COALESCE(payments.reference, excluded.reference),
      updated_at = excluded.updated_at
    WHERE excluded.updated_at >= payments.updated_at`)
  return "recorded"
}

// ---------------------------------------------------------------------------
// Polar
// ---------------------------------------------------------------------------

const amount = z.number().int().nullish()
const polarEventSchema = z.object({
  type: z.string(),
  timestamp: z.string().optional(),
  data: z
    .object({
      id: z.string().min(1).max(200),
      created_at: z.string().nullish(),
      status: z.string().nullish(),
      paid: z.boolean().nullish(),
      currency: z.string().min(3).max(8).nullish(),
      net_amount: amount,
      subtotal_amount: amount,
      discount_amount: amount,
      amount,
      total_amount: amount,
      tax_amount: amount,
      refunded_amount: amount,
      billing_reason: z.string().nullish(),
      description: z.string().nullish(),
      metadata: z.record(z.string(), z.unknown()).nullish(),
      custom_field_data: z.record(z.string(), z.unknown()).nullish(),
      product: z.object({ name: z.string().nullish() }).nullish(),
    })
    .loose(),
})

const PAID_STATES = new Set(["paid", "refunded", "partially_refunded"])

/** Maps a Polar webhook body to an order, or undefined for other events. */
export function polarOrder(
  body: unknown,
  nowSec: number
): OrderInput | undefined {
  const parsed = polarEventSchema.safeParse(body)
  if (!parsed.success) return undefined
  const { type, data } = parsed.data
  const settled =
    type === "order.paid" ||
    type === "order.refunded" ||
    (type === "order.updated" &&
      (data.paid === true || PAID_STATES.has(data.status ?? "")))
  if (!settled) return undefined
  const seconds = (value?: string | null) => {
    const time = value ? Date.parse(value) : NaN
    return Number.isFinite(time) ? Math.floor(time / 1000) : undefined
  }
  const reportedAt = seconds(parsed.data.timestamp) ?? nowSec
  // Revenue excludes tax, which is collected on the government's behalf.
  const net =
    data.net_amount ??
    (data.subtotal_amount != null
      ? data.subtotal_amount - (data.discount_amount ?? 0)
      : undefined) ??
    data.amount ??
    (data.total_amount != null
      ? data.total_amount - (data.tax_amount ?? 0)
      : undefined)
  if (net == null || net < 0) return undefined
  const reference = [
    data.metadata?.reference_id,
    ...Object.values(data.metadata ?? {}),
    ...Object.values(data.custom_field_data ?? {}),
  ].find((value) => parseAttributionReference(value))
  return {
    provider: "polar",
    orderId: data.id,
    amount: net,
    refundedAmount:
      data.status === "refunded" ? net : (data.refunded_amount ?? 0),
    currency: data.currency ?? "usd",
    product: data.product?.name ?? data.description ?? undefined,
    billingReason: data.billing_reason ?? undefined,
    reference: typeof reference === "string" ? reference : undefined,
    reportedAt,
    createdAt: seconds(data.created_at) ?? reportedAt,
  }
}

const SIGNATURE_TOLERANCE_SEC = 5 * 60

type Bytes = Uint8Array<ArrayBuffer>

function base64Bytes(value: string): Bytes | undefined {
  try {
    const text = atob(value)
    const bytes = new Uint8Array(text.length)
    for (let index = 0; index < text.length; index++)
      bytes[index] = text.charCodeAt(index)
    return bytes
  } catch {
    return undefined
  }
}

/**
 * Verifies a Standard Webhooks signature. Polar signs with the decoded
 * `whsec_` secret; endpoints created before September 2026 sign with the
 * secret's own text, so both keys are accepted.
 */
export async function verifyWebhookSignature(
  body: string,
  headers: Headers,
  secrets: Array<string>,
  nowSec: number
): Promise<boolean> {
  const id = headers.get("webhook-id")
  const timestamp = headers.get("webhook-timestamp")
  const signatures = (headers.get("webhook-signature") ?? "")
    .split(" ")
    .map((part) => part.split(","))
    .filter(([version, value]) => version === "v1" && value)
    .map(([, value]) => base64Bytes(value))
    .filter((value): value is Bytes => value !== undefined)
  if (!id || !timestamp || !/^\d+$/.test(timestamp) || !signatures.length)
    return false
  if (Math.abs(nowSec - Number(timestamp)) > SIGNATURE_TOLERANCE_SEC)
    return false
  const encoder = new TextEncoder()
  const message = encoder.encode(`${id}.${timestamp}.${body}`)
  for (const secret of secrets) {
    const keys: Array<Bytes> = [encoder.encode(secret)]
    if (secret.startsWith("whsec_")) {
      const decoded = base64Bytes(secret.slice("whsec_".length))
      if (decoded?.length) keys.unshift(decoded)
    }
    for (const raw of keys) {
      const key = await crypto.subtle.importKey(
        "raw",
        raw,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"]
      )
      for (const signature of signatures)
        if (await crypto.subtle.verify("HMAC", key, signature, message))
          return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface PaymentTotal {
  currency: string
  /** Net of refunds, in minor units. */
  revenue: number
  payments: number
}
export interface PaymentRow {
  id: number
  paidAt: number
  amount: number
  refundedAmount: number
  currency: string
  status: string
  product: string | null
  billingReason: string | null
  /** False when the order carried no reference to a recorded page. */
  attributed: boolean
  path: string | null
  entryPage: string | null
  referrerDomain: string | null
  utmSource: string | null
  utmCampaign: string | null
  country: string | null
}
export interface PaymentsResult {
  totals: Array<PaymentTotal>
  payments: number
  /** Distinct visits in the result that led to a payment. */
  paidVisits: number
  rows: Array<PaymentRow>
}

/** Payments made within the range, optionally limited to matching visits. */
export async function computePayments(
  site: Site,
  resolved: ResolvedRange,
  filters?: VisitFilters,
  limit = 50
): Promise<PaymentsResult> {
  const startSec = Math.floor(
    startOfDayUtcMs(resolved.fromDate, site.timezone) / 1000
  )
  const endSec = Math.min(
    Math.floor(Date.now() / 1000) + 1,
    Math.floor(
      startOfDayUtcMs(shiftDate(resolved.toDate, 1), site.timezone) / 1000
    )
  )
  const visitFilter = visitsFilter(site.id, filters, "fv")
  const matching = sql`pay.site_id = ${site.id} AND pay.paid_at >= ${startSec} AND pay.paid_at < ${endSec}
    ${
      visitFilter
        ? sql`AND EXISTS (SELECT 1 FROM pages fpg JOIN visits fv ON fv.id = fpg.visit_id
            WHERE fpg.id = pay.page_id AND ${visitFilter})`
        : sql``
    }`
  const [totals, rows] = await Promise.all([
    db.all<{
      currency: string
      revenue: number
      payments: number
      paidVisits: number
    }>(sql`SELECT pay.currency AS currency, SUM(pay.amount - pay.refunded_amount) AS revenue,
        SUM(pay.status != 'refunded') AS payments,
        COUNT(DISTINCT CASE WHEN pay.status != 'refunded' THEN pg.visit_id END) AS paidVisits
      FROM payments pay LEFT JOIN pages pg ON pg.id = pay.page_id
      WHERE ${matching} GROUP BY pay.currency ORDER BY revenue DESC`),
    db.all<Omit<PaymentRow, "attributed"> & { attributed: number }>(sql`
      SELECT pay.id AS id, pay.paid_at AS paidAt, pay.amount AS amount,
        pay.refunded_amount AS refundedAmount, pay.currency AS currency, pay.status AS status,
        pay.product AS product, pay.billing_reason AS billingReason,
        pg.id IS NOT NULL AS attributed, pg.path AS path, v.entry_page AS entryPage,
        s.referrer_domain AS referrerDomain, NULLIF(s.utm_source, '') AS utmSource,
        NULLIF(s.utm_campaign, '') AS utmCampaign, l.country AS country
      FROM payments pay
      LEFT JOIN pages pg ON pg.id = pay.page_id
      LEFT JOIN visits v ON v.id = pg.visit_id
      LEFT JOIN sources s ON s.id = v.source_id
      LEFT JOIN locations l ON l.id = v.location_id
      WHERE ${matching} ORDER BY pay.paid_at DESC, pay.id DESC LIMIT ${limit}`),
  ])
  return {
    totals: totals.map((row) => ({
      currency: row.currency,
      revenue: Number(row.revenue),
      payments: Number(row.payments),
    })),
    payments: totals.reduce((sum, row) => sum + Number(row.payments), 0),
    // A visit pays in one currency in practice; summing keeps this one query.
    paidVisits: totals.reduce((sum, row) => sum + Number(row.paidVisits), 0),
    rows: rows.map((row) => ({ ...row, attributed: Boolean(row.attributed) })),
  }
}
