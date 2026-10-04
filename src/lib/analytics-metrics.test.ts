import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  handleCollectRequest,
  normalizeOutboundUrl,
  processCollectRequest,
} from "../routes/collect"
import { recordEngagement, recordInteraction } from "./engagement"
import { recordPage } from "./session"
import { computeSummary } from "./summary"
import { computeRawStats } from "./raw-stats"
import { aggregateSiteDay, runDailyAggregation } from "./aggregate"
import {
  computeEventList,
  computeTopDevices,
  computeTopLocations,
  computeTopPages,
  computeTopSources,
} from "./top-lists"
import { computeTimeseries } from "./timeseries"
import { collectRequestSchema } from "./collect-schema"
import { loadSourceUrlDetails } from "./source-url-details"
import {
  MAX_RECORDED_PATH_CHARS,
  MAX_RECORDED_URL_CHARS,
  OMITTED_OUTBOUND_URL,
  OMITTED_PAGE_PATH,
  SOURCE_DETAILS_CACHE_SECONDS,
} from "./analytics-config"
import { parseReferrer } from "./lookups"
import type { CollectRequest } from "./collect-schema"

const d1 = vi.hoisted(() => ({ prepare: vi.fn(), batch: vi.fn() }))
const live = vi.hoisted(() => ({ ping: vi.fn().mockResolvedValue(1) }))
vi.mock("cloudflare:workers", () => ({
  env: { DB: d1, LIVE_VISITORS: { getByName: () => live } },
  waitUntil: (promise: Promise<unknown>) => {
    void promise
  },
}))
let database: DatabaseSync
const boundStatements: Array<{
  query: string
  values: Array<string | number>
}> = []
const site = {
  id: "site",
  name: "Fixture",
  domain: "fixture.example",
  timezone: "UTC",
  createdAt: 0,
}
const range = {
  fromDate: "2026-09-01",
  toDate: "2026-09-03",
  today: "2026-09-03",
}
const start = Date.parse("2026-09-01T12:00:00Z") / 1000
const pageId = "00000000-0000-4000-8000-000000000001"

beforeEach(() => {
  boundStatements.length = 0
  d1.prepare.mockClear()
  d1.batch.mockClear()
  live.ping.mockClear()
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-09-03T12:00:00Z"))
  database = new DatabaseSync(":memory:")
  const migrations = new URL("../../drizzle/", import.meta.url)
  for (const file of readdirSync(migrations)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()) {
    database.exec(readFileSync(new URL(file, migrations), "utf8"))
  }
  d1.prepare.mockImplementation((query: string) => {
    const prepare = (values: Array<string | number> = []) => {
      boundStatements.push({ query, values })
      return {
        bind: (...bound: Array<string | number>) => prepare(bound),
        all: () =>
          Promise.resolve({ results: database.prepare(query).all(...values) }),
        run: () =>
          Promise.resolve({
            meta: database.prepare(query).run(...values),
            results: [],
          }),
        raw: () => {
          const statement = database.prepare(query)
          statement.setReturnArrays(true)
          return Promise.resolve(statement.all(...values))
        },
      }
    }
    return prepare()
  })
  d1.batch.mockImplementation(
    async (statements: Array<{ run: () => Promise<unknown> }>) => {
      database.exec("BEGIN")
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        database.exec("COMMIT")
        return results
      } catch (error) {
        database.exec("ROLLBACK")
        throw error
      }
    }
  )
  database
    .prepare("INSERT INTO sites VALUES (?, ?, ?, ?, ?)")
    .run(site.id, site.name, site.domain, site.timezone, 0)
  database
    .prepare("INSERT INTO visitors VALUES (?, ?, ?, ?)")
    .run("one", site.id, start, start)
  database
    .prepare("INSERT INTO visitors VALUES (?, ?, ?, ?)")
    .run("two", site.id, start, start)
})
afterEach(() => {
  database.close()
  vi.useRealTimers()
})

function addVisit(
  id: string,
  visitorId = "one",
  timestamp = start,
  measured: number | null = 0
) {
  database
    .prepare(
      `INSERT INTO visits (id, site_id, visitor_id, started_at, ended_at, entry_page, exit_page, duration_ms) VALUES (?, 'site', ?, ?, ?, '/', '/', ?)`
    )
    .run(id, visitorId, timestamp, timestamp, measured)
}
function addPage(visitId: string, trackingId = pageId, timestamp = start) {
  database
    .prepare(
      "INSERT INTO pages (site_id, visit_id, path, timestamp, tracking_id) VALUES ('site', ?, '/', ?, ?)"
    )
    .run(visitId, timestamp, trackingId)
}
function visit(id = "visit") {
  return database
    .prepare(
      "SELECT duration_ms, is_bounce, ended_at, page_count FROM visits WHERE id = ?"
    )
    .get(id)
}

describe("engagement and sessions", () => {
  it("measures single-page reading without inflating pageviews, and ignores retry/out-of-order totals", async () => {
    addVisit("visit")
    addPage("visit")
    await recordEngagement("site", "one", pageId, 9000, start + 9)
    expect(visit()?.is_bounce).toBe(1)
    await recordEngagement("site", "one", pageId, 15000, start + 15)
    await recordEngagement("site", "one", pageId, 15000, start + 16)
    await recordEngagement("site", "one", pageId, 9000, start + 17)
    expect(visit()?.duration_ms).toBe(15000)
    expect(visit()?.is_bounce).toBe(0)
    expect(visit()?.ended_at).toBe(start + 15)
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM pages").get()?.count
    ).toBe(1)
    expect(
      (await computeRawStats("site", start - 1, start + 20)).avgDurationSeconds
    ).toBe(15)
  })
  it("adds time from multiple pages once and cannot update another visitor's page", async () => {
    addVisit("visit")
    addPage("visit")
    const nextPage = "00000000-0000-4000-8000-000000000002"
    addPage("visit", nextPage, start + 20)
    await recordEngagement("site", "one", pageId, 15000, start + 30)
    await recordEngagement("site", "one", nextPage, 12000, start + 35)
    expect(
      await recordEngagement("site", "two", pageId, 99999, start + 100)
    ).toBe(false)
    expect(visit()?.duration_ms).toBe(27000)
  })
  it("caps reported time at the page's elapsed lifetime", async () => {
    addVisit("visit")
    addPage("visit")
    await recordEngagement("site", "one", pageId, 86400000, start + 5)
    expect(visit()?.duration_ms).toBe(6000)
    expect(visit()?.is_bounce).toBe(1)
  })
  it("treats interactions as engagement and keeps delayed actions on their original visit", async () => {
    addVisit("visit")
    addPage("visit")
    addVisit("later", "one", start + 2000)
    expect(await recordInteraction("site", "one", start + 5, pageId)).toBe(
      "visit"
    )
    expect(visit()?.is_bounce).toBe(0)
    expect(visit("later")?.is_bounce).toBe(1)
    expect(await recordInteraction("site", "two", start + 5, pageId)).toBeNull()
    expect(await recordInteraction("site", "one", start + 4000)).toBeNull()
  })
  it("continues sessions based on last activity, then starts a new visit after inactivity", async () => {
    addVisit("visit")
    database.prepare("UPDATE visits SET ended_at = ?").run(start + 1900)
    const params = {
      siteId: "site",
      visitorId: "one",
      path: "/next",
      timestampMs: (start + 2000) * 1000,
      sourceId: null,
      deviceId: null,
      locationId: null,
      measureDuration: true,
    }
    expect(await recordPage(params)).toEqual({
      visitId: "visit",
      isNewVisit: false,
    })
    expect(visit()?.page_count).toBe(2)
    expect(
      (await recordPage({ ...params, timestampMs: (start + 3801) * 1000 }))
        .isNewVisit
    ).toBe(true)
  })
  it("preserves legacy estimates in raw statistics and daily rollups", async () => {
    addVisit("legacy", "one", start, null)
    database
      .prepare("UPDATE visits SET ended_at = ? WHERE id = 'legacy'")
      .run(start + 40)
    addVisit("measured", "two", start, 20000)
    expect(
      (await computeRawStats("site", start - 1, start + 60)).avgDurationSeconds
    ).toBe(30)
    await aggregateSiteDay("site", "UTC", "2026-09-01")
    expect(
      database.prepare("SELECT avg_duration_seconds FROM daily_summary").get()
        ?.avg_duration_seconds
    ).toBe(30)
  })
})

describe("dashboard totals and attribution", () => {
  it("deduplicates visitors across historical days and today while preserving visits", async () => {
    addVisit("day-one")
    addVisit("day-two", "one", start + 86400)
    addVisit("day-three", "one", start + 2 * 86400 - 1)
    addVisit("other", "two", start + 2 * 86400 - 1)
    for (const day of ["2026-09-01", "2026-09-02"])
      await aggregateSiteDay("site", "UTC", day)
    const summary = await computeSummary(site, range)
    expect(summary.visitors).toBe(2)
    expect(summary.visits).toBe(4)
    expect(
      (await computeSummary(site, { ...range, toDate: "2026-09-02" })).visitors
    ).toBe(1)
  })
  it("uses all event occurrences in the denominator, including events beyond the top ten", async () => {
    for (let index = 0; index < 12; index++)
      database
        .prepare(
          "INSERT INTO daily_events VALUES ('site', '2026-09-01', ?, 10)"
        )
        .run(`event-${index}`)
    database
      .prepare(
        "INSERT INTO daily_rollup_status (site_id, date, start_sec, end_sec, version) VALUES ('site', '2026-09-01', ?, ?, 2)"
      )
      .run(start - 43200, start + 43200)
    const events = await computeEventList(site, range)
    expect(events.rows).toHaveLength(10)
    expect(events.total).toBe(120)
  })
  it("keeps Direct, Unknown, external referrers, and campaign attribution distinct", async () => {
    expect(parseReferrer(null, site.domain).referrerDomain).toBe("(direct)")
    expect(parseReferrer(undefined, site.domain).referrerDomain).toBe(
      "(unknown)"
    )
    expect(parseReferrer("http://[broken", site.domain).referrerDomain).toBe(
      "(unknown)"
    )
    expect(
      parseReferrer("file:///private/path", site.domain).referrerDomain
    ).toBe("(unknown)")
    expect(
      parseReferrer("https://fixture.example/page", site.domain).referrerDomain
    ).toBe("(direct)")
    expect(
      parseReferrer("https://google.com/search", site.domain, {
        utmSource: "newsletter",
      })
    ).toMatchObject({ referrerDomain: "google.com", utmSource: "newsletter" })
    for (const source of ["(direct)", "(unknown)"])
      database
        .prepare(
          "INSERT INTO daily_sources VALUES ('site', '2026-09-01', ?, '', '', '', 4)"
        )
        .run(source)
    database
      .prepare(
        "INSERT INTO daily_rollup_status (site_id, date, start_sec, end_sec, version) VALUES ('site', '2026-09-01', ?, ?, 2)"
      )
      .run(start - 43200, start + 43200)
    expect(
      (await computeTopSources(site, range)).rows.map((row) => row.label)
    ).toEqual(["Direct", "Unknown"])
  })
})

const pageKey = "00000000-0000-4000-8000-000000000010"
const eventId = "00000000-0000-4000-8000-000000000020"
function report(overrides: Partial<CollectRequest> = {}): CollectRequest {
  return {
    version: 2,
    site_id: "site",
    kind: "page",
    page_id: pageId,
    page_key: pageKey,
    context_key: "00000000-0000-4000-8000-000000000050",
    path: "/",
    referrer: null,
    duration_ms: 0,
    elapsed_ms: 0,
    activity_ms: 0,
    ...overrides,
  }
}
function context(now = start * 1000, ip = "192.0.2.1") {
  return {
    now,
    ip,
    userAgent: "Fixture",
    geo: {
      country: "IE",
      region: "Leinster",
      city: "Dublin",
      latitude: 53.3,
      longitude: -6.2,
    },
  }
}
function firstVisit() {
  return database
    .prepare("SELECT * FROM visits ORDER BY started_at LIMIT 1")
    .get()!
}
function count(table: string) {
  return Number(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n)
}

// These use the real SQL and migrations, including D1's transactional batch behavior.
describe("reliable ingestion regression cases", () => {
  it("preserves page order and campaign attribution when the initial POST is delayed in transit", async () => {
    const landing = "https://fixture.example/?utm_source=Presentify"
    const referrer = "https://news.ycombinator.com/item?id=42"
    await processCollectRequest(
      report({
        page_started_at_ms: start * 1000,
        page_url: landing,
        referrer,
        utm_source: "Presentify",
      }),
      context(start * 1000 + 5000)
    )
    await processCollectRequest(
      report({
        kind: "time",
        page_started_at_ms: start * 1000,
        elapsed_ms: 5000,
        duration_ms: 1000,
        activity_ms: 1000,
        referrer,
        utm_source: "Presentify",
      }),
      context(start * 1000 + 5100)
    )
    await processCollectRequest(
      report({
        page_id: "00000000-0000-4000-8000-000000000003",
        page_key: "00000000-0000-4000-8000-000000000004",
        previous_page_id: pageId,
        previous_page_key: pageKey,
        path: "/pricing",
        page_started_at_ms: start * 1000 + 1000,
        elapsed_ms: 4100,
        referrer,
      }),
      context(start * 1000 + 5200)
    )
    // A late replay cannot move the page start or change attribution.
    await processCollectRequest(
      report({
        kind: "time",
        page_started_at_ms: start * 1000,
        elapsed_ms: 120000,
        duration_ms: 1000,
        activity_ms: 1000,
      }),
      context(start * 1000 + 120000)
    )
    expect(count("visits")).toBe(1)
    expect(firstVisit()).toMatchObject({
      started_at: start,
      ended_at: start + 1,
      entry_page: "/",
      exit_page: "/pricing",
      page_count: 2,
      duration_ms: 1000,
      landing_url: landing,
      referrer_url: referrer,
    })
    expect((await computeTopSources(site, range, "utm")).rows[0]).toMatchObject(
      {
        label: "Presentify",
        visits: 1,
      }
    )
    expect((await computeTopPages(site, range, "entered")).rows).toEqual([
      { path: "/", count: 1 },
    ])
    expect((await computeTopPages(site, range, "exited")).rows).toEqual([
      { path: "/pricing", count: 1 },
    ])
    await aggregateSiteDay(site.id, site.timezone, "2026-09-01")
    expect((await computeTopSources(site, range, "utm")).rows[0].visits).toBe(1)
    expect(live.ping.mock.calls.at(-1)?.[2]).toBe((start + 1) * 1000)
  })
  it("keeps pages and actions on their original dates when a request crosses midnight", async () => {
    const born = Date.parse("2026-09-01T23:59:58Z")
    await processCollectRequest(
      report({ page_started_at_ms: born }),
      context(born + 5000)
    )
    await processCollectRequest(
      report({
        kind: "event",
        name: "signup",
        event_id: eventId,
        page_started_at_ms: born,
        elapsed_ms: 5100,
        activity_ms: 1000,
        duration_ms: 1000,
      }),
      context(born + 5200)
    )
    expect(firstVisit().started_at).toBe(born / 1000)
    expect(
      database.prepare("SELECT timestamp FROM events").get()?.timestamp
    ).toBe(born / 1000 + 1)
    await aggregateSiteDay(site.id, site.timezone, "2026-09-01")
    const day = {
      fromDate: "2026-09-01",
      toDate: "2026-09-01",
      today: range.today,
    }
    expect(await computeSummary(site, day)).toMatchObject({
      pageviews: 1,
      visits: 1,
    })
    expect((await computeEventList(site, day)).rows).toEqual([
      { name: "signup", count: 1 },
    ])
  })
  it.each([
    undefined,
    -1000,
    0,
    start * 1000 - 3600000,
    start * 1000 + 3600000,
  ])(
    "retains server-relative timing for old trackers or implausible device timestamps (%s)",
    async (pageStartedAt) => {
      const data = collectRequestSchema.parse(
        report({
          page_started_at_ms: pageStartedAt,
          elapsed_ms: 5000,
        })
      )
      await processCollectRequest(data, context(start * 1000 + 5000))
      expect(firstVisit().started_at).toBe(start)
    }
  )
  it("keeps a click or custom event that arrives before the original page report", async () => {
    for (const action of [
      report({
        kind: "outbound",
        event_id: eventId,
        outbound_url: "https://vendor.example/?id=42#buy",
      }),
      report({
        kind: "event",
        page_id: "00000000-0000-4000-8000-000000000002",
        event_id: "00000000-0000-4000-8000-000000000021",
        name: "signup",
      }),
    ]) {
      await processCollectRequest(action, context())
      await processCollectRequest(
        {
          ...action,
          kind: "page",
          event_id: undefined,
          outbound_url: undefined,
          name: undefined,
        },
        context(start * 1000 + 1000)
      )
    }
    expect(count("pages")).toBe(2)
    expect(count("visits")).toBe(1)
    expect(count("outbound_links")).toBe(1)
    expect(count("events")).toBe(1)
    expect(firstVisit().page_count).toBe(2)
    expect(firstVisit().is_bounce).toBe(0)
  })
  it("makes duplicate page, time, and action reports harmless", async () => {
    const action = report({
      kind: "event",
      event_id: eventId,
      name: "signup",
      duration_ms: 15000,
      elapsed_ms: 15000,
      activity_ms: 15000,
    })
    await processCollectRequest(action, context(start * 1000 + 15000))
    await processCollectRequest(action, context(start * 1000 + 15000))
    await processCollectRequest(report(), context(start * 1000 + 16000))
    expect(count("pages")).toBe(1)
    expect(count("events")).toBe(1)
    expect(firstVisit().page_count).toBe(1)
    expect(firstVisit().duration_ms).toBe(15000)
    const outbound = {
      ...action,
      kind: "outbound" as const,
      name: undefined,
      outbound_url: "https://vendor.example/?id=42",
      event_id: "00000000-0000-4000-8000-000000000022",
    }
    await processCollectRequest(outbound, context(start * 1000 + 15000))
    await processCollectRequest(outbound, context(start * 1000 + 15000))
    expect(count("outbound_links")).toBe(1)
  })
  it("does not change page counts when a batch fails, and acknowledges only persisted data", async () => {
    const request = () =>
      new Request("https://analytics.example/collect", {
        method: "POST",
        body: JSON.stringify(report()),
      })
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    d1.batch.mockRejectedValueOnce(new Error("D1 temporarily unavailable"))
    expect((await handleCollectRequest(request())).status).toBe(503)
    expect(count("pages")).toBe(0)
    expect(count("visits")).toBe(0)
    expect((await handleCollectRequest(request())).status).toBe(204)
    expect(count("pages")).toBe(1)
    expect((await handleCollectRequest(request())).status).toBe(204)
    expect(firstVisit().page_count).toBe(1)
    log.mockRestore()
  })
  it("rolls back an interrupted page insert together with its visit", async () => {
    database.exec(
      "CREATE TRIGGER reject_page BEFORE INSERT ON pages BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"
    )
    await expect(
      recordPage({
        siteId: "site",
        visitorId: "one",
        path: "/",
        timestampMs: start * 1000,
        sourceId: null,
        deviceId: null,
        locationId: null,
        pageId,
      })
    ).rejects.toThrow()
    expect(count("visits")).toBe(0)
    expect(count("pages")).toBe(0)
  })
  it("keeps timing and actions on the same visit across an IP change, using private page credentials", async () => {
    await processCollectRequest(report(), context())
    const visitor = firstVisit().visitor_id
    const time = report({
      kind: "time",
      duration_ms: 15000,
      elapsed_ms: 15000,
      activity_ms: 15000,
    })
    await processCollectRequest(
      time,
      context(start * 1000 + 15000, "192.0.2.2")
    )
    await processCollectRequest(
      { ...time, kind: "event", event_id: eventId, name: "signup" },
      context(start * 1000 + 15000, "192.0.2.2")
    )
    expect(firstVisit().duration_ms).toBe(15000)
    expect(firstVisit().visitor_id).toBe(visitor)
    expect(count("events")).toBe(1)
    expect(count("visitors")).toBe(3) // two fixture visitors plus the recognized browser
    expect(
      await processCollectRequest(
        { ...time, page_key: "00000000-0000-4000-8000-000000000099" },
        context(start * 1000 + 15000)
      )
    ).toBe(false)
    expect(firstVisit().duration_ms).toBe(15000)
    await processCollectRequest(
      report({
        page_id: "00000000-0000-4000-8000-000000000003",
        previous_page_id: pageId,
        previous_page_key: pageKey,
        path: "/next",
      }),
      context(start * 1000 + 16000, "192.0.2.2")
    )
    expect(count("visits")).toBe(1)
    expect(firstVisit().page_count).toBe(2)
  })
  it("retains all reading time when the initial page arrived late", async () => {
    await processCollectRequest(report(), context(start * 1000 + 12000))
    await processCollectRequest(
      report({
        kind: "time",
        duration_ms: 15000,
        elapsed_ms: 15000,
        activity_ms: 15000,
      }),
      context(start * 1000 + 15000)
    )
    expect(firstVisit().duration_ms).toBe(15000)
    expect(firstVisit().is_bounce).toBe(0)
  })
  it("uses original activity time for retries, rather than extending a visit or live presence", async () => {
    await processCollectRequest(report(), context())
    await processCollectRequest(
      report({
        kind: "time",
        duration_ms: 12000,
        elapsed_ms: 120000,
        activity_ms: 12000,
      }),
      context(start * 1000 + 120000)
    )
    expect(firstVisit().ended_at).toBe(start + 12)
    expect(live.ping).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Object),
      (start + 12) * 1000
    )
  })
  it("preserves a legacy duration when a visit transitions to measured time", async () => {
    addVisit("legacy", "one", start, null)
    database
      .prepare("UPDATE visits SET ended_at = ? WHERE id = 'legacy'")
      .run(start + 40)
    await recordPage({
      siteId: "site",
      visitorId: "one",
      path: "/next",
      timestampMs: (start + 50) * 1000,
      sourceId: null,
      deviceId: null,
      locationId: null,
      measureDuration: true,
      pageId,
    })
    await recordEngagement("site", "one", pageId, 15000, start + 65)
    expect(visit("legacy")?.duration_ms).toBe(55000)
  })
  it("preserves URL parameters and fragments while rejecting unsafe or internal destinations", () => {
    expect(
      normalizeOutboundUrl(
        "https://vendor.example/?product=42&aff=partner#buy",
        site.domain
      )
    ).toBe("https://vendor.example/?product=42&aff=partner#buy")
    expect(normalizeOutboundUrl("javascript:alert(1)", site.domain)).toBeNull()
    expect(
      normalizeOutboundUrl("https://www.fixture.example/", site.domain)
    ).toBeNull()
    expect(
      collectRequestSchema.safeParse(
        report({ duration_ms: 20000, elapsed_ms: 1000 })
      ).success
    ).toBe(false)
    expect(
      collectRequestSchema.safeParse(report({ page_key: undefined })).success
    ).toBe(false)
  })
})

describe("historical cache correctness", () => {
  it("uses raw records until a day has been rolled up, and invalidates saved days after late activity", async () => {
    const midnight = Date.parse("2026-09-02T00:00:00Z") / 1000
    const started = midnight - 10
    await processCollectRequest(report(), context(started * 1000))
    await processCollectRequest(
      report({
        kind: "time",
        duration_ms: 5000,
        elapsed_ms: 5000,
        activity_ms: 5000,
      }),
      context((started + 5) * 1000)
    )
    const historical = {
      fromDate: "2026-09-01",
      toDate: "2026-09-01",
      today: "2026-09-03",
    }
    expect((await computeSummary(site, historical)).avgDurationSeconds).toBe(5)
    await aggregateSiteDay("site", "UTC", "2026-09-01")
    await aggregateSiteDay("site", "UTC", "2026-09-02")
    expect(count("daily_rollup_status")).toBe(2)
    await processCollectRequest(
      report({
        kind: "time",
        duration_ms: 25000,
        elapsed_ms: 730000,
        activity_ms: 730000,
      }),
      context((started + 730) * 1000)
    )
    expect((await computeSummary(site, historical)).avgDurationSeconds).toBe(25)
    expect((await computeSummary(site, historical)).bounceRate).toBe(0)
    expect((await computeTopPages(site, historical)).total).toBe(1)
    expect((await computeTopSources(site, historical)).total).toBe(1)
    expect((await computeTopDevices(site, historical)).total).toBe(1)
    expect((await computeTopLocations(site, historical)).total).toBe(1)
    expect((await computeTimeseries(site, historical))[0]).toMatchObject({
      visitors: 1,
      pageviews: 1,
    })
    await processCollectRequest(
      report({
        kind: "event",
        event_id: eventId,
        name: "signup",
        elapsed_ms: 731000,
        activity_ms: 731000,
      }),
      context((started + 731) * 1000)
    )
    expect((await computeEventList(site, range)).total).toBe(1)
    await aggregateSiteDay("site", "UTC", "2026-09-01")
    expect((await computeSummary(site, historical)).avgDurationSeconds).toBe(25)
  })
  it("keeps Entered and Exited consistent when a visit spans midnight", async () => {
    const midnight = Date.parse("2026-09-02T00:00:00Z") / 1000
    await processCollectRequest(report(), context((midnight - 10) * 1000))
    await processCollectRequest(
      report({
        page_id: "00000000-0000-4000-8000-000000000002",
        path: "/next",
        previous_page_id: pageId,
        previous_page_key: pageKey,
      }),
      context((midnight + 10) * 1000)
    )
    const historical = { ...range, toDate: "2026-09-01" }
    const raw = await computeTopPages(site, historical, "exited")
    expect(raw.rows).toEqual([{ path: "/next", count: 1 }])
    await aggregateSiteDay("site", "UTC", "2026-09-01")
    expect(await computeTopPages(site, historical, "exited")).toEqual(raw)
  })
  it("publishes all rollup tables atomically and leaves existing cache intact on failure", async () => {
    addVisit("visit")
    addPage("visit")
    await aggregateSiteDay("site", "UTC", "2026-09-01")
    database.exec(
      "CREATE TRIGGER reject_rollup BEFORE INSERT ON daily_events BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"
    )
    database
      .prepare(
        "INSERT INTO events (site_id, visit_id, name, timestamp) VALUES ('site', 'visit', 'signup', ?)"
      )
      .run(start)
    await expect(
      aggregateSiteDay("site", "UTC", "2026-09-01")
    ).rejects.toThrow()
    expect(count("daily_rollup_status")).toBe(1)
    expect(
      database.prepare("SELECT pageviews FROM daily_summary").get()?.pageviews
    ).toBe(1)
    expect(count("daily_pages")).toBe(1)
  })
})

describe("cache recovery and long reporting ranges", () => {
  it("backfills a raw day missed by cron", async () => {
    addVisit("visit")
    addPage("visit")
    await runDailyAggregation()
    expect(count("daily_rollup_status")).toBe(2)
    expect((await computeSummary(site, range)).pageviews).toBe(1)
  })
  it("ignores and repairs rollups built for a different timezone", async () => {
    const timestamp = Date.parse("2026-09-01T23:30:00Z") / 1000
    addVisit("visit", "one", timestamp)
    addPage("visit", pageId, timestamp)
    await aggregateSiteDay("site", "UTC", "2026-09-01")
    const changedSite = { ...site, timezone: "Europe/Dublin" }
    expect(
      (await computeSummary(changedSite, { ...range, toDate: "2026-09-01" }))
        .pageviews
    ).toBe(0)
    database.exec("UPDATE sites SET timezone = 'Europe/Dublin'")
    await runDailyAggregation()
    expect(
      database
        .prepare(
          "SELECT pageviews FROM daily_summary WHERE date = '2026-09-01'"
        )
        .get()?.pageviews
    ).toBe(0)
    expect((await computeSummary(changedSite, range)).pageviews).toBe(1)
  })
  it("queries a full uncached year without exceeding D1 SQL or parameter limits", async () => {
    addVisit("visit")
    addPage("visit")
    const year = { ...range, fromDate: "2025-09-04" }
    const points = await computeTimeseries(site, year)
    expect(points).toHaveLength(365)
    expect(points.reduce((sum, point) => sum + point.pageviews, 0)).toBe(1)
    for (const [query] of d1.prepare.mock.calls) {
      expect(Buffer.byteLength(query)).toBeLessThan(100000)
      expect((query.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100)
    }
  })
  it("falls back to a single raw interval if too many cached days are fragmented", async () => {
    addVisit("visit")
    addPage("visit")
    const from = Date.parse("2026-07-24T00:00:00Z") / 1000
    for (let index = 0; index < 40; index += 2) {
      const dayStart = from + index * 86400
      database
        .prepare(
          "INSERT INTO daily_rollup_status (site_id, date, start_sec, end_sec, version) VALUES ('site', ?, ?, ?, 2)"
        )
        .run(
          new Date(dayStart * 1000).toISOString().slice(0, 10),
          dayStart,
          dayStart + 86400
        )
    }
    const summary = await computeSummary(site, {
      ...range,
      fromDate: "2026-07-24",
    })
    expect(summary.pageviews).toBe(1)
    expect(summary.visits).toBe(1)
  })
})

it("bounds each aggregation invocation even when many sites need backfills", async () => {
  for (let index = 0; index < 6; index++)
    database
      .prepare("INSERT INTO sites VALUES (?, ?, ?, 'UTC', 0)")
      .run(`extra-${index}`, `Extra ${index}`, `extra-${index}.example`)
  await runDailyAggregation()
  expect(d1.batch).toHaveBeenCalledTimes(4)
  expect(d1.prepare.mock.calls.length).toBeLessThanOrEqual(50)
  expect(count("daily_rollup_status")).toBe(3)
})

describe("session reconciliation and activity reporting", () => {
  it("merges a continuous reading visit when its heartbeat arrives after the next page and moves events safely", async () => {
    database.exec("PRAGMA foreign_keys = ON")
    await processCollectRequest(report(), context())
    const original = firstVisit().id
    await aggregateSiteDay("site", "UTC", "2026-09-01")
    const nextId = "00000000-0000-4000-8000-000000000002"
    await processCollectRequest(
      report({
        page_id: nextId,
        path: "/next",
        kind: "event",
        name: "signup",
        event_id: eventId,
      }),
      context((start + 2400) * 1000)
    )
    expect(count("visits")).toBe(2)
    await processCollectRequest(
      report({
        kind: "time",
        duration_ms: 2390000,
        elapsed_ms: 2401000,
        activity_ms: 2390000,
      }),
      context((start + 2401) * 1000)
    )
    expect(count("visits")).toBe(1)
    expect(firstVisit()).toMatchObject({
      id: original,
      page_count: 2,
      entry_page: "/",
      exit_page: "/next",
      duration_ms: 2390000,
      is_bounce: 0,
    })
    expect(
      database
        .prepare(
          "SELECT DISTINCT visit_id FROM pages UNION SELECT visit_id FROM events"
        )
        .all()
    ).toEqual([{ visit_id: original }])
    expect(count("daily_rollup_status")).toBe(0)
    const summary = await computeSummary(site, range)
    expect(summary).toMatchObject({
      visits: 1,
      pageviews: 2,
      avgDurationSeconds: 2390,
    })
    await aggregateSiteDay("site", "UTC", "2026-09-01")
    expect(await computeSummary(site, range)).toEqual(summary)
    // Repeats must not add either visit's duration twice after merging.
    await processCollectRequest(
      report({
        kind: "time",
        duration_ms: 2390000,
        elapsed_ms: 2402000,
        activity_ms: 2390000,
      }),
      context((start + 2402) * 1000)
    )
    expect(firstVisit().duration_ms).toBe(2390000)
  })

  it("joins transitive session bridges in arrival-independent chronological order", async () => {
    const params = {
      siteId: "site",
      visitorId: "one",
      sourceId: null,
      deviceId: null,
      locationId: null,
      measureDuration: true,
    }
    for (const [path, seconds] of [
      ["/a", 0],
      ["/c", 2400],
      ["/b", 1200],
    ] as const)
      await recordPage({
        ...params,
        path,
        timestampMs: (start + seconds) * 1000,
      })
    expect(count("visits")).toBe(1)
    expect(firstVisit()).toMatchObject({
      entry_page: "/a",
      exit_page: "/c",
      page_count: 3,
    })
  })

  it("keeps separate visits at the exact 30-minute inactivity boundary", async () => {
    await processCollectRequest(report(), context())
    await processCollectRequest(
      report({ page_id: "00000000-0000-4000-8000-000000000002" }),
      context((start + 1800) * 1000)
    )
    expect(count("visits")).toBe(2)
  })

  it("rolls back the timing update and all reassignment if reconciliation fails", async () => {
    await processCollectRequest(report(), context())
    await processCollectRequest(
      report({ page_id: "00000000-0000-4000-8000-000000000002" }),
      context((start + 2400) * 1000)
    )
    database.exec(
      "CREATE TRIGGER reject_merge BEFORE DELETE ON visits BEGIN SELECT RAISE(ABORT, 'merge failure'); END"
    )
    await expect(
      processCollectRequest(
        report({
          kind: "time",
          duration_ms: 2390000,
          elapsed_ms: 2401000,
          activity_ms: 2390000,
        }),
        context((start + 2401) * 1000)
      )
    ).rejects.toThrow("merge failure")
    expect(count("visits")).toBe(2)
    expect(firstVisit().duration_ms).toBe(0)
    expect(
      database.prepare("SELECT COUNT(DISTINCT visit_id) AS n FROM pages").get()
        ?.n
    ).toBe(2)
  })

  it("preserves landing attribution when a migrated page has no tracking identifier", async () => {
    await processCollectRequest(
      { site_id: "site", path: "/landing", referrer: "google.com" },
      context()
    )
    database.exec("UPDATE pages SET tracking_id = NULL")
    await processCollectRequest(
      report({ path: "/pricing" }),
      context((start + 20) * 1000)
    )
    expect(firstVisit()).toMatchObject({
      entry_page: "/landing",
      exit_page: "/pricing",
      page_count: 2,
    })
    expect(
      database
        .prepare("SELECT referrer_domain FROM sources WHERE id = ?")
        .get(firstVisit().source_id)?.referrer_domain
    ).toBe("google.com")
  })

  it("does not revive an inactive visitor or extend a visit on a delayed duplicate action", async () => {
    const action = report({
      kind: "event",
      name: "signup",
      event_id: eventId,
      duration_ms: 12000,
      activity_ms: 12000,
      elapsed_ms: 12000,
    })
    await processCollectRequest(action, context((start + 12) * 1000))
    await processCollectRequest(action, context((start + 612) * 1000))
    expect(count("events")).toBe(1)
    expect(firstVisit().ended_at).toBe(start + 12)
    expect(live.ping.mock.calls.at(-1)?.[2]).toBe((start + 12) * 1000)
    expect(
      database.prepare("SELECT timestamp FROM events").get()?.timestamp
    ).toBe(start + 12)
  })

  it("keeps the complete first action report within the free Worker query budget", async () => {
    d1.prepare.mockClear()
    await processCollectRequest(
      report({
        kind: "outbound",
        outbound_url: "https://vendor.example/?aff=partner#buy",
        event_id: eventId,
      }),
      context()
    )
    expect(d1.prepare.mock.calls.length).toBeLessThanOrEqual(50)
  })
})

describe("reporting boundary regressions", () => {
  it("counts visitors across midnight in raw and cached reports, while counting visits by their start", async () => {
    const midnight = Date.parse("2026-09-02T00:00:00Z")
    await processCollectRequest(report(), context(midnight - 60000))
    await processCollectRequest(
      report({
        page_id: "00000000-0000-4000-8000-000000000002",
        path: "/pricing",
      }),
      context(midnight + 60000)
    )
    const day = { ...range, fromDate: "2026-09-02", toDate: "2026-09-02" }
    const summary = await computeSummary(site, day)
    expect(summary).toMatchObject({ visitors: 1, visits: 0, pageviews: 1 })
    expect(
      (await computeRawStats("site", midnight / 1000, midnight / 1000 + 86400))
        .visitors
    ).toBe(1)
    expect((await computeTimeseries(site, day))[0]).toMatchObject({
      visitors: 1,
      pageviews: 1,
    })
    await aggregateSiteDay("site", "UTC", "2026-09-02")
    expect(await computeSummary(site, day)).toEqual(summary)
    expect((await computeTimeseries(site, day))[0]).toMatchObject({
      visitors: 1,
      pageviews: 1,
    })
  })

  it("invalidates the next day's visitor cache when late reading crosses midnight", async () => {
    const midnight = Date.parse("2026-09-02T00:00:00Z")
    await processCollectRequest(report(), context(midnight - 60000))
    await aggregateSiteDay("site", "UTC", "2026-09-02")
    expect(count("daily_rollup_status")).toBe(1)
    await processCollectRequest(
      report({
        kind: "time",
        duration_ms: 120000,
        elapsed_ms: 120000,
        activity_ms: 120000,
      }),
      context(midnight + 60000)
    )
    expect(count("daily_rollup_status")).toBe(0)
    expect(
      (
        await computeSummary(site, {
          ...range,
          fromDate: "2026-09-02",
          toDate: "2026-09-02",
        })
      ).visitors
    ).toBe(1)
  })

  it("ignores totals cached with the previous metric version", async () => {
    addVisit("visit")
    addPage("visit")
    await aggregateSiteDay("site", "UTC", "2026-09-01")
    database.exec(
      "UPDATE daily_rollup_status SET version = 1; UPDATE daily_summary SET pageviews = 99"
    )
    expect((await computeSummary(site, range)).pageviews).toBe(1)
    await runDailyAggregation()
    expect(
      database
        .prepare(
          "SELECT pageviews FROM daily_summary WHERE date = '2026-09-01'"
        )
        .get()?.pageviews
    ).toBe(1)
  })

  it("keeps two-year custom chart queries small and uses a constant number of scans", async () => {
    addVisit("visit")
    addPage("visit")
    d1.prepare.mockClear()
    expect(
      await computeTimeseries(site, { ...range, fromDate: "2024-09-04" })
    ).toHaveLength(730)
    expect(d1.prepare.mock.calls.length).toBe(3)
    for (const [query] of d1.prepare.mock.calls) {
      expect(Buffer.byteLength(query)).toBeLessThan(5000)
      expect((query.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100)
    }
  })

  it.each([
    ["2026-10-25", "2026-10-25T23:30:00Z", 25],
    ["2026-03-29", "2026-03-29T22:30:00Z", 23],
  ])(
    "includes every hourly bucket on Dublin's %s clock-change day",
    async (date, now, hours) => {
      vi.setSystemTime(new Date(now))
      const timestamp = Date.parse(now) / 1000 - 900
      addVisit("visit", "one", timestamp)
      addPage("visit", pageId, timestamp)
      const day = { fromDate: date, toDate: date, today: date }
      const changedSite = { ...site, timezone: "Europe/Dublin" }
      const chart = await computeTimeseries(changedSite, day)
      expect(chart).toHaveLength(hours)
      expect(chart.reduce((sum, point) => sum + point.pageviews, 0)).toBe(1)
      expect((await computeSummary(changedSite, day)).pageviews).toBe(1)
      expect(new Set(chart.map((point) => point.timestamp)).size).toBe(hours)
    }
  )
})

it("generates raw demo history whose visitors and charts agree before and after timezone-aware aggregation", async () => {
  vi.useRealTimers()
  const fixture = mkdtempSync(join(tmpdir(), "analytics-seed-test-"))
  try {
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../scripts/seed-demo-data.mjs", import.meta.url)
        ),
        "site",
        "3",
      ],
      { cwd: fixture }
    )
    database.exec("PRAGMA foreign_keys = ON")
    database.exec(readFileSync(join(fixture, "seed-output.sql"), "utf8"))
    expect(count("daily_rollup_status")).toBe(0)
    const first = database
      .prepare("SELECT MIN(started_at) AS first FROM visits")
      .get()!.first as number
    const day = new Date(first * 1000).toISOString().slice(0, 10)
    const historical = {
      fromDate: day,
      toDate: day,
      today: new Date().toISOString().slice(0, 10),
    }
    for (const timezone of ["UTC", "Europe/Dublin"]) {
      const changedSite = { ...site, timezone }
      const summary = await computeSummary(changedSite, historical)
      expect(summary.visitors).toBeGreaterThan(0)
      expect(summary.pageviews).toBeGreaterThan(0)
      const points = await computeTimeseries(changedSite, historical)
      expect(points[0]).toMatchObject({
        visitors: summary.visitors,
        pageviews: summary.pageviews,
      })
      await aggregateSiteDay("site", timezone, day)
      expect(await computeSummary(changedSite, historical)).toEqual(summary)
      expect(await computeTimeseries(changedSite, historical)).toEqual(points)
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

describe("source details and resilient reporting", () => {
  it("keeps counts, engagement, and actions when a page path exceeds its recording limit", async () => {
    const path = "/download/" + "x".repeat(MAX_RECORDED_PATH_CHARS)
    const base = report({ path, page_url: `https://fixture.example${path}` })
    const send = (data: unknown) =>
      handleCollectRequest(
        new Request("https://analytics.example/collect", {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            "User-Agent": "Fixture",
            "CF-Connecting-IP": "192.0.2.1",
          },
          body: JSON.stringify(data),
        })
      )
    expect((await send(base)).status).toBe(204)
    vi.advanceTimersByTime(15000)
    const active = {
      ...base,
      elapsed_ms: 15000,
      activity_ms: 15000,
      duration_ms: 15000,
    }
    expect((await send({ ...active, kind: "time" })).status).toBe(204)
    expect(
      (
        await send({
          ...active,
          kind: "event",
          event_id: crypto.randomUUID(),
          name: "signup",
        })
      ).status
    ).toBe(204)
    expect(
      (
        await send({
          ...active,
          kind: "outbound",
          event_id: crypto.randomUUID(),
          outbound_url: "https://vendor.example/offer",
        })
      ).status
    ).toBe(204)
    expect(firstVisit()).toMatchObject({
      entry_page: OMITTED_PAGE_PATH,
      exit_page: OMITTED_PAGE_PATH,
      page_count: 1,
      duration_ms: 15000,
      is_bounce: 0,
      landing_url: null,
    })
    expect(count("events")).toBe(1)
    expect(count("outbound_links")).toBe(1)
    for (const dimension of ["top", "entered", "exited"] as const) {
      expect((await computeTopPages(site, range, dimension)).rows).toEqual([
        { path: OMITTED_PAGE_PATH, count: 1 },
      ])
    }
    await aggregateSiteDay("site", "UTC", range.toDate)
    expect(database.prepare("SELECT path FROM daily_pages").get()?.path).toBe(
      OMITTED_PAGE_PATH
    )
    expect(
      collectRequestSchema.parse({
        site_id: "site",
        path: "/" + "x".repeat(MAX_RECORDED_PATH_CHARS - 1),
      }).path?.length
    ).toBe(MAX_RECORDED_PATH_CHARS)
  })
  it("shares one cache entry and calculation across equivalent campaign identifiers", async () => {
    await processCollectRequest(
      report({
        utm_source: "Presentify",
        page_url: "https://fixture.example/?utm_source=Presentify",
      }),
      context()
    )
    const keys = [
      '["Presentify","",""]',
      '[ "Presentify", "", "" ]',
      '["\\u0050resentify","",""]',
    ]
    d1.prepare.mockClear()
    const results = await Promise.all(
      keys.map((key) => loadSourceUrlDetails(site, range, { view: "utm", key }))
    )
    expect(results[0]?.links).toHaveLength(1)
    expect(
      results.every(
        (value) => JSON.stringify(value) === JSON.stringify(results[0])
      )
    ).toBe(true)
    expect(
      d1.prepare.mock.calls.filter(([query]) =>
        query.includes("eligible AS MATERIALIZED")
      )
    ).toHaveLength(1)
    expect(
      d1.prepare.mock.calls.filter(([query]) =>
        query.startsWith('insert into "source_details_cache"')
      )
    ).toHaveLength(1)
    d1.prepare.mockClear()
    expect(
      await loadSourceUrlDetails(site, range, { view: "utm", key: keys[1] })
    ).toEqual(results[0])
    expect(d1.prepare.mock.calls).toHaveLength(1)
    expect(
      database.prepare("SELECT COUNT(*) AS n FROM source_details_cache").get()
        ?.n
    ).toBe(1)
  })
  it("uses every campaign index column even when matching legacy NULL values", async () => {
    for (const tags of [
      ["Presentify", "email", "launch"],
      ["Presentify", "", ""],
      ["", "email", ""],
      ["", "", "launch"],
    ]) {
      const rows = tags.reduce<Array<Array<string | null>>>(
        (variants, tag) =>
          variants.flatMap((row) =>
            (tag === "" ? ["", null] : [tag]).map((value) => [...row, value])
          ),
        [[]]
      )
      for (const [i, row] of rows.entries()) {
        const source = database
          .prepare(
            "INSERT INTO sources (site_id, referrer_domain, utm_source, utm_medium, utm_campaign) VALUES ('site', ?, ?, ?, ?) RETURNING id"
          )
          .get(`legacy-${tags.join("-")}-${i}.example`, ...row)!
        const id = crypto.randomUUID()
        addVisit(id)
        database
          .prepare("UPDATE visits SET source_id=?,landing_url=? WHERE id=?")
          .run(source.id, "https://fixture.example/offers", id)
      }
      const result = await loadSourceUrlDetails(site, range, {
        view: "utm",
        key: JSON.stringify(tags),
      })
      expect(result?.links[0].visits).toBe(rows.length)
      const statement = boundStatements
        .filter(({ query }) => query.includes("eligible AS MATERIALIZED"))
        .at(-1)!
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${statement.query}`)
        .all(...statement.values)
      const searches = plan
        .map((row) => String(row.detail))
        .filter((detail) => detail.includes("idx_sources_site_campaign"))
      expect(searches).toHaveLength(rows.length)
      for (const search of searches)
        expect(search).toContain(
          "site_id=? AND utm_source=? AND utm_medium=? AND utm_campaign=?"
        )
    }
  })
  it("keeps whole URLs at the configured limit and omits longer optional metadata", () => {
    const prefix = "https://fixture.example/?q="
    const exact = prefix + "x".repeat(MAX_RECORDED_URL_CHARS - prefix.length)
    expect(
      collectRequestSchema.parse(report({ page_url: exact })).page_url
    ).toBe(exact)
    expect(
      collectRequestSchema.parse(report({ page_url: exact + "x" })).page_url
    ).toBeUndefined()
    expect(
      collectRequestSchema.parse(report({ page_url: "invalid" })).page_url
    ).toBeUndefined()
  })
  it("counts visits, reading time, and outbound clicks when optional URLs are oversized", async () => {
    const response = await handleCollectRequest(
      new Request("https://analytics.example/collect", {
        method: "POST",
        body: JSON.stringify(
          report({
            page_url: "https://fixture.example/?q=" + "x".repeat(9000),
            referrer:
              "https://presentifyapp.com/articles?query=" + "x".repeat(9000),
            kind: "outbound",
            outbound_url: "https://vendor.example/?q=" + "x".repeat(9000),
            event_id: crypto.randomUUID(),
            duration_ms: 12000,
            elapsed_ms: 12000,
            activity_ms: 12000,
          })
        ),
      })
    )
    expect(response.status).toBe(204)
    expect(firstVisit()).toMatchObject({
      duration_ms: 12000,
      page_count: 1,
      is_bounce: 0,
      referrer_url: null,
      landing_url: null,
    })
    expect(
      database
        .prepare("SELECT referrer_domain FROM sources WHERE id=?")
        .get(firstVisit().source_id)?.referrer_domain
    ).toBe("presentifyapp.com")
    expect(database.prepare("SELECT url FROM outbound_links").get()?.url).toBe(
      OMITTED_OUTBOUND_URL
    )
    expect(
      normalizeOutboundUrl(
        "https://fixture.example/?q=" + "x".repeat(9000),
        site.domain
      )
    ).toBeNull()
    const links = await computeTopSources(site, range, "links")
    expect(links.rows[0].label).toBe("URL exceeds recording limit")
  })
  it("loads URL rankings on demand and reuses the cache until it expires", async () => {
    await processCollectRequest(
      report({
        referrer: "https://presentifyapp.com/offers",
        page_url: "https://fixture.example/?utm_source=Presentify",
        utm_source: "Presentify",
      }),
      context()
    )
    d1.prepare.mockClear()
    const row = (await computeTopSources(site, range, "utm")).rows[0]
    expect(
      d1.prepare.mock.calls.some(([query]) =>
        query.includes("eligible AS MATERIALIZED")
      )
    ).toBe(false)
    const input = { view: "utm" as const, key: row.key }
    const first = await loadSourceUrlDetails(site, range, input)
    expect(first?.links.find((link) => link.kind === "landing")?.visits).toBe(1)
    await processCollectRequest(
      report({
        page_id: crypto.randomUUID(),
        page_key: crypto.randomUUID(),
        context_key: crypto.randomUUID(),
        referrer: "https://presentifyapp.com/offers",
        page_url: "https://fixture.example/?utm_source=Presentify",
        utm_source: "Presentify",
      }),
      context((start + 2000) * 1000)
    )
    d1.prepare.mockClear()
    expect(await loadSourceUrlDetails(site, range, input)).toEqual(first)
    expect(d1.prepare.mock.calls).toHaveLength(1)
    vi.advanceTimersByTime(SOURCE_DETAILS_CACHE_SECONDS * 1000 + 1)
    expect(
      (await loadSourceUrlDetails(site, range, input))?.links.find(
        (link) => link.kind === "landing"
      )?.visits
    ).toBe(2)
    expect(
      await loadSourceUrlDetails(site, range, { view: "utm", key: "malformed" })
    ).toBeUndefined()
    expect(
      await loadSourceUrlDetails(site, range, {
        view: "referrer",
        key: "unrecorded.example",
      })
    ).toBeUndefined()
  })
  it("returns the five most visited URLs per kind in descending order", async () => {
    database.exec(
      "INSERT INTO sources (site_id,referrer_domain,utm_source) VALUES ('site','presentifyapp.com','Presentify')"
    )
    const sourceId = database
      .prepare("SELECT id FROM sources WHERE utm_source='Presentify'")
      .get()!.id
    for (let rank = 1; rank <= 8; rank++)
      for (let occurrence = 0; occurrence < rank; occurrence++) {
        const id = `rank-${rank}-${occurrence}`
        addVisit(id)
        database
          .prepare(
            "UPDATE visits SET source_id=?,referrer_url=?,landing_url=? WHERE id=?"
          )
          .run(
            sourceId,
            `https://presentifyapp.com/offer/${rank}`,
            `https://fixture.example/?utm_source=Presentify&offer=${rank}`,
            id
          )
      }
    const details = await loadSourceUrlDetails(site, range, {
      view: "utm",
      key: JSON.stringify(["Presentify", "", ""]),
    })
    expect(details?.hasMore).toBe(true)
    for (const kind of ["referrer", "landing"])
      expect(
        details?.links
          .filter((link) => link.kind === kind)
          .map((link) => link.visits)
      ).toEqual([8, 7, 6, 5, 4])
  })
  it("rejects invalid timezones, while existing invalid sites cannot stop valid backfills", async () => {
    const { insertSiteSchema } = await import("@/db/schema")
    expect(
      insertSiteSchema.safeParse({
        name: "Typo",
        domain: "typo.example",
        timezone: "Europe/Dublinn",
      }).success
    ).toBe(false)
    addVisit("visit")
    addPage("visit")
    database
      .prepare("INSERT INTO sites VALUES (?, ?, ?, ?, ?)")
      .run("bad", "Typo", "typo.example", "Europe/Dublinn", 0)
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    await runDailyAggregation()
    expect(count("daily_rollup_status")).toBeGreaterThan(0)
    expect(log).toHaveBeenCalledWith(
      "Aggregation planning failed",
      "bad",
      expect.any(String)
    )
    log.mockRestore()
  })
  it("continues other days after one rollup fails", async () => {
    addVisit("visit")
    addPage("visit")
    database.exec(
      "CREATE TRIGGER reject_first BEFORE INSERT ON daily_events WHEN NEW.date = '2026-09-01' BEGIN SELECT RAISE(ABORT, 'failure'); END"
    )
    // Add an event to make the failing day's insert invoke the trigger.
    database
      .prepare(
        "INSERT INTO events (site_id,visit_id,name,timestamp) VALUES ('site','visit','signup',?)"
      )
      .run(start)
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    await runDailyAggregation()
    expect(
      database
        .prepare("SELECT date FROM daily_rollup_status WHERE version = 2")
        .all()
    ).toEqual([{ date: "2026-09-02" }])
    expect(log).toHaveBeenCalledWith(
      "Aggregation failed",
      "site",
      "2026-09-01",
      expect.any(String)
    )
    log.mockRestore()
  })
  it("backs off failed days durably and makes progress for healthy websites", async () => {
    addVisit("good-visit")
    addPage("good-visit")
    for (let index = 1; index <= 3; index++)
      database
        .prepare("INSERT INTO sites VALUES (?, ?, ?, ?, ?)")
        .run(
          `bad-${index}`,
          "Large site",
          `bad-${index}.example`,
          "America/Los_Angeles",
          0
        )
    database.exec(
      "CREATE TRIGGER reject_large BEFORE INSERT ON daily_summary WHEN NEW.site_id LIKE 'bad-%' BEGIN SELECT RAISE(ABORT, 'day timeout'); END"
    )
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    for (let hour = 12; hour <= 13; hour++) {
      vi.setSystemTime(new Date(`2026-09-03T${hour}:00:00Z`))
      d1.prepare.mockClear()
      await runDailyAggregation()
      expect(d1.prepare.mock.calls.length).toBeLessThanOrEqual(50)
    }
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM daily_rollup_status WHERE site_id = 'site' AND version = 2"
        )
        .get()?.count
    ).toBeGreaterThan(0)
    const failed = database
      .prepare(
        "SELECT site_id, failures, retry_at FROM daily_rollup_status WHERE version = 0"
      )
      .all()
    expect(failed).toHaveLength(3)
    expect(failed.every((day) => day.failures === 1)).toBe(true)
    // Retry timing comes from D1, and survives a fresh planning pass.
    vi.setSystemTime(new Date("2026-09-03T16:00:00Z"))
    await runDailyAggregation()
    expect(
      database
        .prepare(
          "SELECT MIN(failures) AS failures FROM daily_rollup_status WHERE version = 0"
        )
        .get()?.failures
    ).toBe(2)
    database.exec("DROP TRIGGER reject_large")
    vi.setSystemTime(new Date("2026-09-03T20:00:00Z"))
    await runDailyAggregation()
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM daily_rollup_status WHERE version = 0"
        )
        .get()?.count
    ).toBe(0)
    expect(
      database
        .prepare(
          "SELECT MAX(failures) AS failures, MAX(retry_at) AS retry_at FROM daily_rollup_status"
        )
        .get()
    ).toEqual({ failures: 0, retry_at: 0 })
    log.mockRestore()
  })
  it("repairs older healthy days while newer days of the same website are backing off", async () => {
    addVisit("visit")
    addPage("visit")
    addVisit("recent", "two", start + 86400)
    addPage("recent", "00000000-0000-4000-8000-000000000099", start + 86400)
    database.exec(
      "CREATE TRIGGER reject_recent BEFORE INSERT ON daily_summary WHEN NEW.date = '2026-09-02' BEGIN SELECT RAISE(ABORT, 'day timeout'); END"
    )
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    await runDailyAggregation()
    expect((await computeSummary(site, range)).pageviews).toBe(2)
    expect(
      database
        .prepare("SELECT date, version FROM daily_rollup_status ORDER BY date")
        .all()
    ).toEqual([
      { date: "2026-09-01", version: 2 },
      { date: "2026-09-02", version: 0 },
    ])
    const attempts = log.mock.calls.length
    vi.setSystemTime(new Date("2026-09-03T13:00:00Z"))
    await runDailyAggregation()
    expect(log.mock.calls.length).toBe(attempts)
    log.mockRestore()
  })
  it("recognizes pages arriving backwards across a network change without persistent browser storage", async () => {
    await processCollectRequest(
      report({
        page_id: "00000000-0000-4000-8000-000000000003",
        page_key: "00000000-0000-4000-8000-000000000004",
        previous_page_id: pageId,
        previous_page_key: pageKey,
        path: "/next",
      }),
      context(start * 1000 + 20000, "192.0.2.2")
    )
    await processCollectRequest(
      report({
        kind: "time",
        elapsed_ms: 21000,
        activity_ms: 10000,
        duration_ms: 10000,
        referrer: "https://news.ycombinator.com/item?id=42",
        utm_source: "Presentify",
      }),
      context(start * 1000 + 21000)
    )
    expect(count("visits")).toBe(1)
    expect(firstVisit().page_count).toBe(2)
    expect(firstVisit().entry_page).toBe("/")
    expect(firstVisit().exit_page).toBe("/next")
    expect((await computeSummary(site, range)).visitors).toBe(1)
    expect((await computeTopSources(site, range)).rows[0].referrerDomain).toBe(
      "news.ycombinator.com"
    )
  })
  it("preserves exact referrer and tagged landing URLs before and after caching", async () => {
    const referrer = "https://news.ycombinator.com/item?id=42#comments"
    const landing =
      "https://fixture.example/?utm_source=Presentify&utm_medium=referral&utm_campaign=summer-launch#offer"
    await processCollectRequest(
      report({
        referrer,
        page_url: landing,
        utm_source: "Presentify",
        utm_medium: "referral",
        utm_campaign: "summer-launch",
      }),
      context()
    )
    for (const cached of [false, true]) {
      if (cached) await aggregateSiteDay("site", "UTC", "2026-09-01")
      const ref = (await computeTopSources(site, range)).rows[0]
      expect(ref.details?.links).toEqual([])
      expect(
        (
          await loadSourceUrlDetails(site, range, {
            view: "referrer",
            key: ref.key,
          })
        )?.links
      ).toEqual([{ url: referrer, kind: "referrer", visits: 1 }])
      const utm = (await computeTopSources(site, range, "utm")).rows[0]
      expect(utm.label).toBe("summer-launch · Presentify / referral")
      const details = await loadSourceUrlDetails(site, range, {
        view: "utm",
        key: utm.key,
      })
      expect(details).toMatchObject({
        utmSource: "Presentify",
        utmMedium: "referral",
        utmCampaign: "summer-launch",
        linkCount: 2,
      })
      expect(details?.links).toContainEqual({
        url: landing,
        kind: "landing",
        visits: 1,
      })
    }
  })
  it("bounds URL details without merging distinct campaigns or inflating visit totals", async () => {
    for (let index = 0; index < 8; index++) {
      const id = crypto.randomUUID()
      await processCollectRequest(
        report({
          page_id: id,
          page_key: crypto.randomUUID(),
          context_key: crypto.randomUUID(),
          referrer: `https://news.ycombinator.com/item?id=${index}`,
          page_url: `https://fixture.example/?utm_source=Presentify&item=${index}`,
          utm_source: "Presentify",
        }),
        context((start + index * 2000) * 1000)
      )
    }
    const campaigns = await computeTopSources(site, range, "utm")
    expect(campaigns.total).toBe(8)
    expect(campaigns.rows).toHaveLength(1)
    expect(campaigns.rows[0].details?.links).toHaveLength(0)
    const details = await loadSourceUrlDetails(site, range, {
      view: "utm",
      key: campaigns.rows[0].key,
    })
    expect(details?.hasMore).toBe(true)
    expect(details?.links).toHaveLength(10)
  })
  it("carries visitors over gaps between uncached days and deduplicates repeated visits", async () => {
    addVisit("long")
    database
      .prepare("UPDATE visits SET ended_at = ? WHERE id='long'")
      .run(start + 2 * 86400)
    addVisit("other", "one", start + 2 * 86400)
    await aggregateSiteDay("site", "UTC", "2026-09-02")
    const chart = await computeTimeseries(site, range)
    expect(chart.map((point) => point.visitors)).toEqual([1, 1, 1])
  })
})
