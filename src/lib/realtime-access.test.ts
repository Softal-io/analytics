import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { authorizedRealtimeSessions } from "./realtime-access"

const bindings = vi.hoisted(() => ({ DB: undefined as unknown as D1Database }))
vi.mock("cloudflare:workers", () => ({ env: bindings }))
let database: DatabaseSync
let parameterCounts: Array<number>
function session(id = "session", expires = Date.now() + 60_000, verified = 1) {
  database
    .prepare("INSERT INTO auth_user VALUES (?, ?, ?)")
    .run(id, `${id}@example.com`, verified)
  database
    .prepare("INSERT INTO auth_session VALUES (?, ?, ?)")
    .run(id, id, expires)
  database
    .prepare("INSERT INTO access_grants VALUES (?, ?)")
    .run(`${id}@example.com`, "viewer")
}

describe("live connection access", () => {
  beforeEach(() => {
    database = new DatabaseSync(":memory:")
    database.exec(`
      CREATE TABLE auth_user (id TEXT PRIMARY KEY, email TEXT, email_verified INTEGER);
      CREATE TABLE auth_session (id TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER);
      CREATE TABLE access_grants (email TEXT PRIMARY KEY, role TEXT);
    `)
    parameterCounts = []
    bindings.DB = {
      prepare(query: string) {
        return {
          bind(...values: Array<string | number>) {
            parameterCounts.push(values.length)
            return {
              all: () =>
                Promise.resolve({
                  results: database.prepare(query).all(...values),
                }),
            }
          },
        }
      },
    } as unknown as D1Database
  })
  afterEach(() => database.close())

  it("allows verified sessions with a current grant", async () => {
    session()
    expect(await authorizedRealtimeSessions(["session"])).toEqual(
      new Set(["session"])
    )
  })
  it("rejects a revoked grant on the very next check", async () => {
    session()
    expect((await authorizedRealtimeSessions(["session"])).size).toBe(1)
    database.exec("DELETE FROM access_grants")
    expect((await authorizedRealtimeSessions(["session"])).size).toBe(0)
  })
  it("rejects expired, signed-out, and unverified sessions", async () => {
    session("expired", Date.now())
    session("unverified", Date.now() + 60_000, 0)
    session("signed-out")
    database.prepare("DELETE FROM auth_session WHERE id = ?").run("signed-out")
    expect(
      (
        await authorizedRealtimeSessions([
          "expired",
          "unverified",
          "signed-out",
        ])
      ).size
    ).toBe(0)
  })
  it("deduplicates session IDs and respects D1's parameter limit", async () => {
    const ids = Array.from({ length: 120 }, (_, index) => `session-${index}`)
    for (const id of ids) session(id)
    expect((await authorizedRealtimeSessions([...ids, ...ids])).size).toBe(120)
    expect(parameterCounts).toEqual([100, 22])
  })
  it("does not query D1 when there are no live connections", async () => {
    expect((await authorizedRealtimeSessions([])).size).toBe(0)
    expect(parameterCounts).toEqual([])
  })
})
