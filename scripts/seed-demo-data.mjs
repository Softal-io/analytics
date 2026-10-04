#!/usr/bin/env node
/**
 * Seeds realistic demo data for local development.
 *
 * Replaces a site's analytics rows with data for the last N calendar days.
 * All days use raw records. Reports and the normal aggregation job apply
 * the site's timezone and the same metric definitions as real traffic.
 *
 * Usage:
 *   node scripts/seed-demo-data.mjs <site-id> [days]
 *
 * Then apply the generated SQL with:
 *   npx wrangler d1 execute DB --local --file=./seed-output.sql
 *
 * (This script only *generates* the SQL file — it doesn't touch D1
 * itself, so it has no dependency on wrangler/miniflare internals.)
 */
import { randomBytes, randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"

const siteId = process.argv[2]
const days = Number(process.argv[3] ?? 30)

// Full paths are illustrative sample data, not claims about real referrals.
const referringUrls = {
  "google.com": "https://google.com/search?q=website+analytics",
  "news.ycombinator.com": "https://news.ycombinator.com/item?id=1",
  "github.com": "https://github.com/torvalds/linux",
  "linkedin.com": "https://linkedin.com/feed/",
  "bing.com": "https://bing.com/search?q=website+analytics",
}

if (!siteId) {
  console.error("Usage: node scripts/seed-demo-data.mjs <site-id> [days]")
  process.exit(1)
}

if (!Number.isInteger(days) || days < 1) {
  console.error("[days] must be a positive integer")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Weighted real-world dictionaries
// ---------------------------------------------------------------------------

const REFERRERS = [
  {
    referrerDomain: "(direct)",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    weight: 30,
  },
  {
    referrerDomain: "google.com",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    weight: 26,
  },
  {
    referrerDomain: "github.com",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    weight: 9,
  },
  {
    referrerDomain: "news.ycombinator.com",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    weight: 7,
  },
  {
    referrerDomain: "t.co",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    weight: 5,
  },
  {
    referrerDomain: "reddit.com",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    weight: 5,
  },
  {
    referrerDomain: "producthunt.com",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    weight: 4,
  },
  {
    referrerDomain: "linkedin.com",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    weight: 3,
  },
  {
    referrerDomain: "bing.com",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    weight: 3,
  },
  {
    referrerDomain: "dev.to",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    weight: 3,
  },
  {
    referrerDomain: "facebook.com",
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    weight: 2,
  },
  {
    referrerDomain: "(direct)",
    utmSource: "newsletter",
    utmMedium: "email",
    utmCampaign: "weekly-digest",
    weight: 4,
  },
  {
    referrerDomain: "twitter.com",
    utmSource: "twitter",
    utmMedium: "social",
    utmCampaign: "launch",
    weight: 3,
  },
  {
    referrerDomain: "linkedin.com",
    utmSource: "linkedin",
    utmMedium: "social",
    utmCampaign: "product-update",
    weight: 3,
  },
  {
    referrerDomain: "google.com",
    utmSource: "google",
    utmMedium: "cpc",
    utmCampaign: "summer-launch",
    weight: 2,
  },
  {
    referrerDomain: "producthunt.com",
    utmSource: "product-hunt",
    utmMedium: "referral",
    utmCampaign: "launch-day",
    weight: 2,
  },
]

const DEVICES = [
  { browser: "Chrome", os: "Windows", deviceType: "desktop", weight: 30 },
  { browser: "Chrome", os: "macOS", deviceType: "desktop", weight: 18 },
  { browser: "Safari", os: "macOS", deviceType: "desktop", weight: 12 },
  { browser: "Safari", os: "iOS", deviceType: "mobile", weight: 14 },
  { browser: "Chrome", os: "Android", deviceType: "mobile", weight: 10 },
  { browser: "Firefox", os: "Windows", deviceType: "desktop", weight: 6 },
  { browser: "Edge", os: "Windows", deviceType: "desktop", weight: 5 },
  { browser: "Safari", os: "iOS", deviceType: "tablet", weight: 3 },
  {
    browser: "Samsung Internet",
    os: "Android",
    deviceType: "mobile",
    weight: 2,
  },
]

const LOCATIONS = [
  { country: "US", region: "CA", city: "San Francisco", weight: 14 },
  { country: "US", region: "NY", city: "New York", weight: 12 },
  { country: "US", region: "TX", city: "Austin", weight: 8 },
  { country: "US", region: "WA", city: "Seattle", weight: 6 },
  { country: "GB", region: "", city: "London", weight: 10 },
  { country: "IN", region: "KA", city: "Bangalore", weight: 9 },
  { country: "IN", region: "MH", city: "Mumbai", weight: 5 },
  { country: "DE", region: "BE", city: "Berlin", weight: 7 },
  { country: "CA", region: "ON", city: "Toronto", weight: 6 },
  { country: "AU", region: "NSW", city: "Sydney", weight: 5 },
  { country: "NL", region: "", city: "Amsterdam", weight: 4 },
  { country: "FR", region: "", city: "Paris", weight: 4 },
  { country: "JP", region: "", city: "Tokyo", weight: 4 },
  { country: "BR", region: "SP", city: "Sao Paulo", weight: 4 },
  { country: "SG", region: "", city: "Singapore", weight: 3 },
]

const PAGES = [
  { path: "/", title: "SuperSaaS – Ship your SaaS faster", weight: 35 },
  { path: "/pricing", title: "Pricing – SuperSaaS", weight: 15 },
  { path: "/docs", title: "Docs – SuperSaaS", weight: 12 },
  {
    path: "/docs/getting-started",
    title: "Getting Started – SuperSaaS",
    weight: 10,
  },
  { path: "/blog", title: "Blog – SuperSaaS", weight: 8 },
  {
    path: "/blog/how-we-built-supersaas",
    title: "How we built SuperSaaS",
    weight: 6,
  },
  { path: "/changelog", title: "Changelog – SuperSaaS", weight: 5 },
  { path: "/about", title: "About – SuperSaaS", weight: 5 },
  { path: "/contact", title: "Contact – SuperSaaS", weight: 4 },
]

const EVENT_RULES = [
  { name: "signup", pages: ["/pricing", "/"], chance: 0.06 },
  { name: "pricing_click", pages: ["/"], chance: 0.08 },
  {
    name: "docs_search",
    pages: ["/docs", "/docs/getting-started"],
    chance: 0.12,
  },
  { name: "newsletter_subscribe", pages: ["/blog", "/"], chance: 0.04 },
  { name: "cta_click", pages: ["/", "/pricing"], chance: 0.1 },
]

const OUTBOUND_LINKS = [
  { url: "https://github.com/supersaas", weight: 35 },
  { url: "https://docs.cloudflare.com/workers", weight: 22 },
  { url: "https://discord.com/invite/supersaas", weight: 18 },
  { url: "https://x.com/supersaas", weight: 15 },
  { url: "https://status.supersaas.example", weight: 10 },
]

const PAGE_COUNT_WEIGHTS = [1, 1, 1, 2, 2, 3, 4, 5]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function weightedPick(items) {
  const total = items.reduce((s, i) => s + i.weight, 0)
  let r = Math.random() * total
  for (const item of items) {
    if (r < item.weight) return item
    r -= item.weight
  }
  return items[items.length - 1]
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function newVisitorId() {
  return randomBytes(16).toString("hex")
}

function esc(value) {
  if (value === null || value === undefined) return "NULL"
  return `'${String(value).replace(/'/g, "''")}'`
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10)
}

const sourceKeySeen = new Set()
const deviceKeySeen = new Set()
const locationKeySeen = new Set()
const lookupInserts = []

function ensureSourceLookup(ref) {
  const key = `${ref.referrerDomain}\u0000${ref.utmSource}\u0000${ref.utmMedium}\u0000${ref.utmCampaign}`
  if (!sourceKeySeen.has(key)) {
    sourceKeySeen.add(key)
    lookupInserts.push(
      `INSERT OR IGNORE INTO sources (site_id, referrer_domain, utm_source, utm_medium, utm_campaign) VALUES (${esc(siteId)}, ${esc(ref.referrerDomain)}, ${esc(ref.utmSource)}, ${esc(ref.utmMedium)}, ${esc(ref.utmCampaign)});`
    )
  }
}

function ensureDeviceLookup(dev) {
  const key = `${dev.browser}\u0000${dev.os}\u0000${dev.deviceType}`
  if (!deviceKeySeen.has(key)) {
    deviceKeySeen.add(key)
    lookupInserts.push(
      `INSERT OR IGNORE INTO devices (browser, os, device_type) VALUES (${esc(dev.browser)}, ${esc(dev.os)}, ${esc(dev.deviceType)});`
    )
  }
}

function ensureLocationLookup(loc) {
  const key = `${loc.country}\u0000${loc.region}\u0000${loc.city}`
  if (!locationKeySeen.has(key)) {
    locationKeySeen.add(key)
    lookupInserts.push(
      `INSERT OR IGNORE INTO locations (country, region, city) VALUES (${esc(loc.country)}, ${esc(loc.region)}, ${esc(loc.city)});`
    )
  }
}

function sourceIdSubquery(ref) {
  return `(SELECT id FROM sources WHERE site_id = ${esc(siteId)} AND referrer_domain = ${esc(ref.referrerDomain)} AND utm_source = ${esc(ref.utmSource)} AND utm_medium = ${esc(ref.utmMedium)} AND utm_campaign = ${esc(ref.utmCampaign)})`
}
function deviceIdSubquery(dev) {
  return `(SELECT id FROM devices WHERE browser = ${esc(dev.browser)} AND os = ${esc(dev.os)} AND device_type = ${esc(dev.deviceType)})`
}
function locationIdSubquery(loc) {
  return `(SELECT id FROM locations WHERE country = ${esc(loc.country)} AND region = ${esc(loc.region)} AND city = ${esc(loc.city)})`
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

// Remove the selected site's existing analytics rows first so re-seeding
// cannot leave stale dates outside the requested window. Shared device and
// location lookup rows are intentionally retained because other sites may use
// them; sources are site-specific and can be safely replaced.
const cleanupStatements = [
  `DELETE FROM daily_events WHERE site_id = ${esc(siteId)};`,
  `DELETE FROM daily_outbound_links WHERE site_id = ${esc(siteId)};`,
  `DELETE FROM daily_locations WHERE site_id = ${esc(siteId)};`,
  `DELETE FROM daily_devices WHERE site_id = ${esc(siteId)};`,
  `DELETE FROM daily_sources WHERE site_id = ${esc(siteId)};`,
  `DELETE FROM daily_pages WHERE site_id = ${esc(siteId)};`,
  `DELETE FROM daily_summary WHERE site_id = ${esc(siteId)};`,
  `DELETE FROM daily_rollup_status WHERE site_id = ${esc(siteId)};`,
  `DELETE FROM events WHERE site_id = ${esc(siteId)};`,
  `DELETE FROM outbound_links WHERE site_id = ${esc(siteId)};`,
  `DELETE FROM pages WHERE site_id = ${esc(siteId)};`,
  `DELETE FROM visits WHERE site_id = ${esc(siteId)};`,
  `DELETE FROM tracking_contexts WHERE site_id = ${esc(siteId)};`,
  `DELETE FROM source_details_cache WHERE site_id = ${esc(siteId)};`,
  `DELETE FROM visitors WHERE site_id = ${esc(siteId)};`,
  `DELETE FROM sources WHERE site_id = ${esc(siteId)};`,
]
const statements = []

const allVisitorIds = []
const visitorFirstSeen = new Map()
const visitorLastSeen = new Map()

function pickVisitorId() {
  if (allVisitorIds.length > 0 && Math.random() < 0.32) {
    return pick(allVisitorIds)
  }
  const id = newVisitorId()
  allVisitorIds.push(id)
  return id
}

function markVisitorSeen(id, sec) {
  if (!visitorFirstSeen.has(id) || sec < visitorFirstSeen.get(id))
    visitorFirstSeen.set(id, sec)
  if (!visitorLastSeen.has(id) || sec > visitorLastSeen.get(id))
    visitorLastSeen.set(id, sec)
}

const now = new Date()
const todayStr = fmtDate(now)

// Raw data is the source of truth for every day. The normal reporting and cron
// paths apply the site's timezone and metric definitions, without synthetic caches.
const nowSec = Math.floor(now.getTime() / 1000)
let totalVisits = 0
let todayVisitCount = 0
for (let offset = days - 1; offset >= 0; offset--) {
  const date = new Date(`${todayStr}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - offset)
  const dayStart = Math.floor(date.getTime() / 1000)
  const dayEnd = Math.min(dayStart + 86400, nowSec)
  const dow = date.getUTCDay()
  const weekdayMultiplier = dow === 0 || dow === 6 ? 0.6 : 1
  const growth = 1 - (offset / Math.max(days - 1, 1)) * 0.55
  const fraction = offset === 0 ? (dayEnd - dayStart) / 86400 : 1
  const visitCount = Math.max(
    2,
    Math.round(
      40 * growth * weekdayMultiplier * fraction * (0.7 + Math.random() * 0.6)
    )
  )
  totalVisits += visitCount
  if (offset === 0) todayVisitCount = visitCount
  for (let i = 0; i < visitCount; i++) {
    const visitorId = pickVisitorId()
    const device = weightedPick(DEVICES)
    const location = weightedPick(LOCATIONS)
    const referrer = weightedPick(REFERRERS)
    ensureDeviceLookup(device)
    ensureLocationLookup(location)
    ensureSourceLookup(referrer)

    const pageCount = pick(PAGE_COUNT_WEIGHTS)
    const duration = Math.min(
      randInt(4, 180) * pageCount,
      Math.max(0, dayEnd - dayStart)
    )
    const startedAt = randInt(dayStart, Math.max(dayStart, dayEnd - duration))
    const endedAt = startedAt + duration
    markVisitorSeen(visitorId, startedAt)
    markVisitorSeen(visitorId, endedAt)
    const visitId = randomUUID()
    const visitedPaths = Array.from({ length: pageCount }, () =>
      weightedPick(PAGES)
    )
    const durationMs = duration * 1000
    const bounce = pageCount === 1 && durationMs <= 10000
    const referringUrl =
      referrer.referrerDomain === "(direct)"
        ? null
        : (referringUrls[referrer.referrerDomain] ??
          `https://${referrer.referrerDomain}/`)
    const tags = new URLSearchParams()
    for (const [name, value] of [
      ["utm_source", referrer.utmSource],
      ["utm_medium", referrer.utmMedium],
      ["utm_campaign", referrer.utmCampaign],
    ]) {
      if (value) tags.set(name, value)
    }
    const landingPath = visitedPaths[0].path + (tags.size ? `?${tags}` : "")
    const landingUrl = `(SELECT CASE WHEN instr(domain, '://') > 0 THEN rtrim(domain, '/') ELSE 'https://' || domain END FROM sites WHERE id = ${esc(siteId)}) || ${esc(landingPath)}`
    statements.push(
      `INSERT INTO visits (id, site_id, visitor_id, started_at, ended_at, duration_ms, entry_page, exit_page, page_count, is_bounce, source_id, device_id, location_id, referrer_url, landing_url) VALUES (${esc(visitId)}, ${esc(siteId)}, ${esc(visitorId)}, ${startedAt}, ${endedAt}, ${durationMs}, ${esc(visitedPaths[0].path)}, ${esc(visitedPaths.at(-1).path)}, ${pageCount}, ${bounce ? 1 : 0}, ${sourceIdSubquery(referrer)}, ${deviceIdSubquery(device)}, ${locationIdSubquery(location)}, ${esc(referringUrl)}, ${landingUrl});`
    )
    let interaction = false
    visitedPaths.forEach((pg, index) => {
      const timestamp = startedAt + Math.floor((duration * index) / pageCount)
      const pageDuration =
        Math.floor((durationMs * (index + 1)) / pageCount) -
        Math.floor((durationMs * index) / pageCount)
      statements.push(
        `INSERT INTO pages (site_id, visit_id, path, title, timestamp, timestamp_ms, duration_ms, tracking_id) VALUES (${esc(siteId)}, ${esc(visitId)}, ${esc(pg.path)}, ${esc(pg.title)}, ${timestamp}, ${timestamp * 1000}, ${pageDuration}, ${esc(randomUUID())});`
      )
      for (const rule of EVENT_RULES) {
        if (rule.pages.includes(pg.path) && Math.random() < rule.chance) {
          interaction = true
          statements.push(
            `INSERT INTO events (site_id, visit_id, name, props, timestamp) VALUES (${esc(siteId)}, ${esc(visitId)}, ${esc(rule.name)}, NULL, ${timestamp});`
          )
        }
      }
    })
    if (Math.random() < 0.18) {
      interaction = true
      const link = weightedPick(OUTBOUND_LINKS)
      statements.push(
        `INSERT INTO outbound_links (site_id, visitor_id, url, timestamp) VALUES (${esc(siteId)}, ${esc(visitorId)}, ${esc(link.url)}, ${endedAt});`
      )
    }
    if (interaction && bounce)
      statements.push(
        `UPDATE visits SET is_bounce = 0 WHERE id = ${esc(visitId)};`
      )
  }
}

const visitorRows = []
for (const [id, first] of visitorFirstSeen) {
  const last = visitorLastSeen.get(id)
  visitorRows.push(
    `INSERT INTO visitors (id, site_id, first_seen, last_seen) VALUES (${esc(id)}, ${esc(siteId)}, ${first}, ${last}) ON CONFLICT (id) DO UPDATE SET last_seen=excluded.last_seen;`
  )
}

// ---------------------------------------------------------------------------
// Assemble output — remove old site data, recreate lookup/visitor FK targets,
// then write raw activity for every generated day.
// ---------------------------------------------------------------------------

const output = [
  ...cleanupStatements,
  ...lookupInserts,
  ...visitorRows,
  ...statements,
].join("\n")
writeFileSync("seed-output.sql", output)

console.log(
  `Generated ${cleanupStatements.length + statements.length + lookupInserts.length + visitorRows.length} statements`
)
console.log(`  - ${totalVisits} raw visits across ${days} UTC calendar days`)
console.log(`  - ${todayVisitCount} raw visits for today (${todayStr})`)
console.log(`  - ${days} calendar days total, including today`)
console.log(`  - ${visitorRows.length} distinct visitors`)
console.log(`Wrote seed-output.sql`)
