import {
  index,
  int,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import type { SourceDetails } from "@/lib/source-details"
import { isValidTimezone } from "@/lib/dates"
import { MAX_RECORDED_URL_CHARS } from "@/lib/analytics-config"
import {
  canShareRealtimeGlobe,
  publicMetrics,
  publicSections,
} from "@/lib/public-options"

/**
 * Personal Web Analytics — data model.
 *
 * See web-analytics-spec.md §5 for the full rationale. Two families of
 * tables:
 *
 *  - Raw tables (sites, visitors, visits, pages, outbound links, sources,
 *    devices, locations, events) — written by `/collect`.
 *  - Rollup tables (daily_*) — written once a day by the cron trigger
 *    (see src/lib/aggregate.ts). The dashboard reads exclusively from
 *    these when the corresponding cache marker is current.
 */

// ---------------------------------------------------------------------------
// Raw tables
// ---------------------------------------------------------------------------

export const sites = sqliteTable("sites", {
  id: text("id").primaryKey(), // uuid
  name: text("name").notNull(),
  domain: text("domain").notNull().unique(),
  timezone: text("timezone").notNull().default("UTC"),
  createdAt: int("created_at").notNull(),
})

// Authentication shares the analytics D1 database. Better Auth owns these rows.
export const authUser = sqliteTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: int("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image"),
  createdAt: int("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: int("updated_at", { mode: "timestamp_ms" }).notNull(),
})

export const authSession = sqliteTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: int("expires_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: int("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: int("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("idx_auth_session_user").on(table.userId)]
)

export const authAccount = sqliteTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: int("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: int("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: int("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: int("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_auth_account_user").on(table.userId),
    uniqueIndex("idx_auth_account_provider").on(
      table.providerId,
      table.accountId
    ),
  ]
)

export const authVerification = sqliteTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: int("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: int("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: int("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("idx_auth_verification_identifier").on(table.identifier)]
)

export const accessGrants = sqliteTable("access_grants", {
  email: text("email").primaryKey(),
  role: text("role", { enum: ["admin", "viewer"] }).notNull(),
  updatedAt: int("updated_at").notNull(),
})

export const sitePublicViews = sqliteTable("site_public_views", {
  siteId: text("site_id")
    .primaryKey()
    .references(() => sites.id, { onDelete: "cascade" }),
  slug: text("slug").notNull().unique(),
  enabled: int("enabled", { mode: "boolean" }).notNull().default(false),
  metrics: text("metrics", { mode: "json" })
    .$type<Array<(typeof publicMetrics)[number]>>()
    .notNull(),
  sections: text("sections", { mode: "json" })
    .$type<Array<(typeof publicSections)[number]>>()
    .notNull(),
  updatedAt: int("updated_at").notNull(),
})

export type AuthUser = typeof authUser.$inferSelect
export type AuthSession = typeof authSession.$inferSelect
export type AuthAccount = typeof authAccount.$inferSelect
export type AuthVerification = typeof authVerification.$inferSelect
export type AccessGrant = typeof accessGrants.$inferSelect
export type SitePublicView = typeof sitePublicViews.$inferSelect
export const selectAuthUserSchema = createSelectSchema(authUser)
export const selectAuthSessionSchema = createSelectSchema(authSession)
export const selectAuthAccountSchema = createSelectSchema(authAccount)
export const selectAuthVerificationSchema = createSelectSchema(authVerification)
export const selectAccessGrantSchema = createSelectSchema(accessGrants)
export const insertAccessGrantSchema = createInsertSchema(accessGrants, {
  email: (field) =>
    field
      .email()
      .max(254)
      .transform((value) => value.trim().toLowerCase()),
}).pick({ email: true, role: true })
export const selectSitePublicViewSchema = createSelectSchema(sitePublicViews)
export const insertSitePublicViewSchema = createInsertSchema(sitePublicViews, {
  slug: (field) =>
    field
      .min(3)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  enabled: z.boolean(),
  metrics: z.array(z.enum(publicMetrics)).max(publicMetrics.length),
  sections: z.array(z.enum(publicSections)).max(publicSections.length),
})
  .pick({ slug: true, enabled: true, metrics: true, sections: true })
  .required()
  .strict()
  .refine(
    (value) =>
      !value.enabled || value.metrics.length + value.sections.length > 0,
    { message: "Choose at least one metric or section to publish." }
  )
  .refine(
    (value) =>
      !value.sections.includes("realtimeGlobe") ||
      canShareRealtimeGlobe(value.sections),
    {
      message:
        "The live location globe requires Cities and Live visitor count.",
    }
  )

export const visitors = sqliteTable(
  "visitors",
  {
    id: text("id").primaryKey(), // sha256(site_id + IP + UA), see §4
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    firstSeen: int("first_seen").notNull(),
    lastSeen: int("last_seen").notNull(),
  },
  (t) => [index("idx_visitors_site_seen").on(t.siteId, t.lastSeen)]
)

/** A browser-document credential links reports despite changed networks or arrival order. */
export const trackingContexts = sqliteTable(
  "tracking_contexts",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    keyHash: text("key_hash").notNull(),
    visitorId: text("visitor_id")
      .notNull()
      .references(() => visitors.id),
    lastSeen: int("last_seen").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.keyHash] }),
    index("idx_tracking_contexts_seen").on(t.lastSeen),
  ]
)
export type TrackingContext = typeof trackingContexts.$inferSelect
export type NewTrackingContext = typeof trackingContexts.$inferInsert
export const selectTrackingContextSchema = createSelectSchema(trackingContexts)
export const insertTrackingContextSchema = createInsertSchema(trackingContexts)

/** Shared, bounded-lifetime cache for expensive URL rankings requested by tooltips. */
export const sourceDetailsCache = sqliteTable(
  "source_details_cache",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    details: text("details", { mode: "json" }).$type<SourceDetails>().notNull(),
    expiresAt: int("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.key] }),
    index("idx_source_details_cache_expiry").on(t.expiresAt),
  ]
)
export type SourceDetailsCache = typeof sourceDetailsCache.$inferSelect
export type NewSourceDetailsCache = typeof sourceDetailsCache.$inferInsert
export const selectSourceDetailsCacheSchema =
  createSelectSchema(sourceDetailsCache)
export const insertSourceDetailsCacheSchema =
  createInsertSchema(sourceDetailsCache)

export const sources = sqliteTable(
  "sources",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    referrerDomain: text("referrer_domain").notNull().default("(direct)"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
  },
  (t) => [
    uniqueIndex("idx_sources_unique").on(
      t.siteId,
      t.referrerDomain,
      t.utmSource,
      t.utmMedium,
      t.utmCampaign
    ),
    index("idx_sources_site_campaign").on(
      t.siteId,
      t.utmSource,
      t.utmMedium,
      t.utmCampaign
    ),
  ]
)

export const devices = sqliteTable(
  "devices",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    browser: text("browser").notNull(),
    os: text("os").notNull(),
    deviceType: text("device_type").notNull(), // desktop | mobile | tablet
  },
  (t) => [uniqueIndex("idx_devices_unique").on(t.browser, t.os, t.deviceType)]
)

export const locations = sqliteTable(
  "locations",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    country: text("country").notNull(), // ISO-2 country code
    region: text("region"),
    city: text("city"),
  },
  (t) => [uniqueIndex("idx_locations_unique").on(t.country, t.region, t.city)]
)

export const visits = sqliteTable(
  "visits",
  {
    id: text("id").primaryKey(), // uuid
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    visitorId: text("visitor_id")
      .notNull()
      .references(() => visitors.id),
    startedAt: int("started_at").notNull(),
    endedAt: int("ended_at").notNull(),
    // Null preserves the legacy first-to-last-pageview estimate.
    durationMs: int("duration_ms"),
    entryPage: text("entry_page"),
    exitPage: text("exit_page"),
    pageCount: int("page_count").notNull().default(1),
    isBounce: int("is_bounce", { mode: "boolean" }).notNull().default(true),
    sourceId: int("source_id").references(() => sources.id),
    referrerUrl: text("referrer_url"),
    landingUrl: text("landing_url"),
    deviceId: int("device_id").references(() => devices.id),
    locationId: int("location_id").references(() => locations.id),
  },
  (t) => [
    index("idx_visits_site_started").on(t.siteId, t.startedAt),
    index("idx_visits_site_started_visitor").on(
      t.siteId,
      t.startedAt,
      t.visitorId
    ),
    index("idx_visits_site_ended_started_visitor").on(
      t.siteId,
      t.endedAt,
      t.startedAt,
      t.visitorId
    ),
    index("idx_visits_visitor").on(t.visitorId, t.startedAt),
    index("idx_visits_site_source_started").on(
      t.siteId,
      t.sourceId,
      t.startedAt
    ),
  ]
)

export const pages = sqliteTable(
  "pages",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    visitId: text("visit_id")
      .notNull()
      .references(() => visits.id),
    path: text("path").notNull(),
    title: text("title"),
    timestamp: int("timestamp").notNull(),
    trackingId: text("tracking_id"),
    reportKeyHash: text("report_key_hash"),
    timestampMs: int("timestamp_ms"),
    durationMs: int("duration_ms").notNull().default(0),
  },
  (t) => [
    index("idx_pages_site_ts").on(t.siteId, t.timestamp),
    index("idx_pages_visit").on(t.visitId),
    uniqueIndex("idx_pages_tracking").on(t.siteId, t.trackingId),
  ]
)

export const outboundLinks = sqliteTable(
  "outbound_links",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    visitorId: text("visitor_id")
      .notNull()
      .references(() => visitors.id),
    url: text("url").notNull(),
    trackingId: text("tracking_id"),
    timestamp: int("timestamp").notNull(),
  },
  (t) => [
    index("idx_outbound_links_site_ts").on(t.siteId, t.timestamp),
    uniqueIndex("idx_outbound_links_tracking").on(t.siteId, t.trackingId),
  ]
)

export const events = sqliteTable(
  "events",
  {
    id: int("id").primaryKey({ autoIncrement: true }),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    visitId: text("visit_id")
      .notNull()
      .references(() => visits.id),
    name: text("name").notNull(),
    trackingId: text("tracking_id"),
    props: text("props"), // JSON blob, small (<2KB)
    timestamp: int("timestamp").notNull(),
  },
  (t) => [
    index("idx_events_site_name_ts").on(t.siteId, t.name, t.timestamp),
    index("idx_events_site_ts").on(t.siteId, t.timestamp),
    uniqueIndex("idx_events_tracking").on(t.siteId, t.trackingId),
  ]
)

// ---------------------------------------------------------------------------
// Rollup tables — written by cron, read by the dashboard (§7, §8)
// ---------------------------------------------------------------------------

/** Current rollups use their metric version; failed days use version 0 and retry timing. */
export const dailyRollupStatus = sqliteTable(
  "daily_rollup_status",
  {
    siteId: text("site_id").notNull(),
    date: text("date").notNull(),
    startSec: int("start_sec").notNull(),
    endSec: int("end_sec").notNull(),
    version: int("version").notNull().default(1),
    failures: int("failures").notNull().default(0),
    retryAt: int("retry_at").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.date] })]
)
export type DailyRollupStatus = typeof dailyRollupStatus.$inferSelect
export type NewDailyRollupStatus = typeof dailyRollupStatus.$inferInsert
export const selectDailyRollupStatusSchema =
  createSelectSchema(dailyRollupStatus)
export const insertDailyRollupStatusSchema =
  createInsertSchema(dailyRollupStatus)

export const dailySummary = sqliteTable(
  "daily_summary",
  {
    siteId: text("site_id").notNull(),
    date: text("date").notNull(), // 'YYYY-MM-DD'
    visitors: int("visitors").notNull(),
    visits: int("visits").notNull(),
    pageviews: int("pageviews").notNull(),
    bounceRate: real("bounce_rate").notNull(),
    avgDurationSeconds: real("avg_duration_seconds").notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.date] })]
)

export const dailyPages = sqliteTable(
  "daily_pages",
  {
    siteId: text("site_id").notNull(),
    date: text("date").notNull(),
    path: text("path").notNull(),
    pageviews: int("pageviews").notNull(),
    visitors: int("visitors").notNull(),
    entrances: int("entrances").notNull().default(0),
    exits: int("exits").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.date, t.path] })]
)

export const dailySources = sqliteTable(
  "daily_sources",
  {
    siteId: text("site_id").notNull(),
    date: text("date").notNull(),
    referrerDomain: text("referrer_domain").notNull(),
    utmSource: text("utm_source").notNull().default(""),
    utmMedium: text("utm_medium").notNull().default(""),
    utmCampaign: text("utm_campaign").notNull().default(""),
    visits: int("visits").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.siteId,
        t.date,
        t.referrerDomain,
        t.utmSource,
        t.utmMedium,
        t.utmCampaign,
      ],
    }),
  ]
)

export const dailyDevices = sqliteTable(
  "daily_devices",
  {
    siteId: text("site_id").notNull(),
    date: text("date").notNull(),
    deviceType: text("device_type").notNull(),
    browser: text("browser").notNull(),
    os: text("os").notNull().default(""),
    visits: int("visits").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.siteId, t.date, t.deviceType, t.browser, t.os],
    }),
  ]
)

export const dailyLocations = sqliteTable(
  "daily_locations",
  {
    siteId: text("site_id").notNull(),
    date: text("date").notNull(),
    country: text("country").notNull(),
    region: text("region").notNull().default(""),
    city: text("city").notNull().default(""),
    visits: int("visits").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.siteId, t.date, t.country, t.region, t.city],
    }),
  ]
)

export const dailyOutboundLinks = sqliteTable(
  "daily_outbound_links",
  {
    siteId: text("site_id").notNull(),
    date: text("date").notNull(),
    url: text("url").notNull(),
    clicks: int("clicks").notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.date, t.url] })]
)

export const dailyEvents = sqliteTable(
  "daily_events",
  {
    siteId: text("site_id").notNull(),
    date: text("date").notNull(),
    name: text("name").notNull(),
    count: int("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.date, t.name] })]
)

// ---------------------------------------------------------------------------
// Types + Zod schemas
// ---------------------------------------------------------------------------

export type Site = typeof sites.$inferSelect
export type NewSite = typeof sites.$inferInsert

export const selectSiteSchema = createSelectSchema(sites)
export const insertSiteSchema = createInsertSchema(sites, {
  name: (schema) => schema.min(1).max(100),
  domain: (schema) => schema.min(1).max(253),
  timezone: (schema) =>
    schema
      .min(1)
      .max(64)
      .refine(
        isValidTimezone,
        "Enter a valid IANA timezone, such as Europe/Dublin"
      ),
})
  .pick({ name: true, domain: true, timezone: true })
  .partial({ timezone: true })

export type InsertSiteInput = z.infer<typeof insertSiteSchema>

export type Visitor = typeof visitors.$inferSelect
export type Visit = typeof visits.$inferSelect
export type Page = typeof pages.$inferSelect
export type OutboundLink = typeof outboundLinks.$inferSelect
export type NewOutboundLink = typeof outboundLinks.$inferInsert
export type EventRow = typeof events.$inferSelect

export const selectOutboundLinkSchema = createSelectSchema(outboundLinks)
export const insertOutboundLinkSchema = createInsertSchema(outboundLinks, {
  url: (schema) => schema.url().max(MAX_RECORDED_URL_CHARS),
}).pick({
  siteId: true,
  visitorId: true,
  url: true,
  timestamp: true,
})

export type InsertOutboundLinkInput = z.infer<typeof insertOutboundLinkSchema>
