import { z } from "zod"
import {
  MAX_RECORDED_PATH_CHARS,
  MAX_RECORDED_URL_CHARS,
  OMITTED_OUTBOUND_URL,
} from "./analytics-config"
import { boundedPagePath, boundedReferrer, recordedUrl } from "./recorded-url"

/**
 * `POST /collect` request body (§6). Either a pageview (`path` present) or
 * a custom event (`name` present).
 */
export const collectRequestSchema = z
  .object({
    site_id: z.string().min(1).max(64),
    // Version 2 reports are self-contained and can be acknowledged/retried.
    version: z.literal(2).optional(),
    kind: z.enum(["page", "time", "event", "outbound"]).optional(),
    page_key: z.string().uuid().optional(),
    context_key: z.string().uuid().optional(),
    page_url: z.preprocess(recordedUrl, z.string().optional()),
    previous_page_id: z.string().uuid().optional(),
    previous_page_key: z.string().uuid().optional(),
    event_id: z.string().uuid().optional(),
    // Optional for compatibility with trackers already installed on websites.
    // Clock plausibility is checked at ingestion so a wrong clock cannot drop the report.
    page_started_at_ms: z.number().int().optional(),
    elapsed_ms: z.number().int().min(0).max(172800000).optional(),
    activity_ms: z.number().int().min(0).max(172800000).optional(),
    // Pageview fields
    path: z.preprocess(
      boundedPagePath,
      z.string().min(1).max(MAX_RECORDED_PATH_CHARS).optional()
    ),
    page_id: z.string().uuid().optional(),
    // Cumulative visible-page time. Repeated or delayed reports are idempotent.
    duration_ms: z.number().int().min(0).max(86400000).optional(),
    title: z.string().max(500).optional().nullable(),
    referrer: z.preprocess(
      boundedReferrer,
      z.string().max(MAX_RECORDED_URL_CHARS).optional().nullable()
    ),
    utm_source: z.string().max(200).optional(),
    utm_medium: z.string().max(200).optional(),
    utm_campaign: z.string().max(500).optional(),
    screen_w: z.number().int().positive().optional(),
    screen_h: z.number().int().positive().optional(),
    // Preserve the complete HTTP(S) destination, including its query and hash.
    outbound_url: z
      .union([z.string().url(), z.literal(OMITTED_OUTBOUND_URL)])
      .optional(),
    // Custom-event fields
    name: z.string().min(1).max(200).optional(),
    props: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.version !== 2) return
    const fail = (message: string) => ctx.addIssue({ code: "custom", message })
    if (
      !data.path ||
      !data.page_id ||
      !data.page_key ||
      !data.kind ||
      data.elapsed_ms === undefined ||
      data.activity_ms === undefined ||
      data.duration_ms === undefined
    )
      fail("Version 2 requires a complete page snapshot.")
    if (
      (data.duration_ms ?? 0) > (data.elapsed_ms ?? 0) ||
      (data.activity_ms ?? 0) > (data.elapsed_ms ?? 0) ||
      (data.duration_ms ?? 0) > (data.activity_ms ?? 0)
    )
      fail("Activity cannot exceed the page's elapsed lifetime.")
    if (Boolean(data.previous_page_id) !== Boolean(data.previous_page_key))
      fail("Previous page credentials must be paired.")
    if (
      data.kind === "event" &&
      (!data.event_id || !data.name || data.outbound_url)
    )
      fail("An event requires its ID and name.")
    if (
      data.kind === "outbound" &&
      (!data.event_id || !data.outbound_url || data.name)
    )
      fail("An outbound click requires its ID and URL.")
    if (
      (data.kind === "page" || data.kind === "time") &&
      (data.name || data.outbound_url || data.event_id)
    )
      fail("Page reports cannot contain actions.")
  })

export type CollectRequest = z.infer<typeof collectRequestSchema>
