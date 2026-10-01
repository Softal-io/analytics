import { DatabaseSync } from "node:sqlite"
import { readFileSync, readdirSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadPublicSnapshot } from "./public-data"

const d1 = vi.hoisted(() => ({ prepare: vi.fn() }))
vi.mock("cloudflare:workers", () => ({ env: { DB: d1 } }))
let database: DatabaseSync

beforeEach(() => {
  database = new DatabaseSync(":memory:")
  const migrations = new URL("../../drizzle/", import.meta.url)
  for (const file of readdirSync(migrations)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()) {
    database.exec(readFileSync(new URL(file, migrations), "utf8"))
  }
  d1.prepare.mockImplementation((query: string) => ({
    bind(...values: Array<string | number>) {
      return {
        all: () =>
          Promise.resolve({ results: database.prepare(query).all(...values) }),
        raw: () => {
          const statement = database.prepare(query)
          statement.setReturnArrays(true)
          return Promise.resolve(statement.all(...values))
        },
      }
    },
  }))
  database
    .prepare("INSERT INTO sites VALUES (?, ?, ?, ?, ?)")
    .run("site", "Public fixture", "fixture.example", "UTC", 0)
  database
    .prepare("INSERT INTO site_public_views VALUES (?, ?, ?, ?, ?, ?)")
    .run("site", "public-fixture", 1, "[]", '["events"]', 0)
  const pastDay = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
  for (let index = 0; index < 20; index++) {
    database
      .prepare("INSERT INTO daily_events VALUES (?, ?, ?, ?)")
      .run("site", pastDay, `event-${index}`, 10)
  }
})
afterEach(() => database.close())

describe("public event totals", () => {
  it("uses all events as the denominator while showing only the top ten", async () => {
    const snapshot = await loadPublicSnapshot("public-fixture", "7d")
    expect(snapshot?.sections.events?.rows).toHaveLength(10)
    expect(snapshot?.sections.events?.total).toBe(200)
    expect(snapshot?.sections.events?.rows[0]?.count).toBe(10)
    expect(Object.keys(snapshot?.sections ?? {})).toEqual(["events"])
    expect(snapshot?.metrics).toEqual({})
  })
  it("merges today's raw events with past rollups before calculating the total", async () => {
    const now = Math.floor(Date.now() / 1000) - 1
    database.exec("PRAGMA foreign_keys = OFF")
    for (let index = 0; index < 3; index++) {
      database
        .prepare(
          "INSERT INTO events (site_id, visit_id, name, props, timestamp) VALUES (?, ?, ?, ?, ?)"
        )
        .run("site", "fixture-visit", "event-0", '{"private":"value"}', now)
    }
    const snapshot = await loadPublicSnapshot("public-fixture", "7d")
    expect(snapshot?.sections.events?.total).toBe(203)
    expect(snapshot?.sections.events?.rows[0]).toEqual({
      label: "event-0",
      count: 13,
    })
    expect(JSON.stringify(snapshot)).not.toContain("private")
  })
  it("returns nothing after the owner disables sharing", async () => {
    database.exec("UPDATE site_public_views SET enabled = 0")
    expect(await loadPublicSnapshot("public-fixture", "7d")).toBeNull()
  })
})
