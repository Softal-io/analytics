import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { grantAccessSql, revokeAccessSql } from "./access-grant-sql.js"

let database: DatabaseSync
function invite(email: string, role = "admin") {
  return database.prepare(grantAccessSql).get(email, role)
}
function signIn(email: string, verified = 1) {
  database.prepare("INSERT INTO auth_user VALUES (?, ?)").run(email, verified)
}

describe("administrator handover", () => {
  beforeEach(() => {
    database = new DatabaseSync(":memory:")
    database.exec(`
      CREATE TABLE access_grants (email TEXT PRIMARY KEY, role TEXT, updated_at INTEGER);
      CREATE TABLE auth_user (email TEXT PRIMARY KEY, email_verified INTEGER);
    `)
  })
  afterEach(() => database.close())

  it("allows bootstrapping an admin before their first sign-in", () => {
    expect(invite("admin@example.com")).toMatchObject({ role: "admin" })
  })
  it("rejects both removal and demotion of the sole signed-in admin with pending invitations", () => {
    invite("admin@example.com")
    signIn("admin@example.com")
    invite("pending@example.com")
    expect(
      database.prepare(revokeAccessSql).get("admin@example.com")
    ).toBeUndefined()
    expect(invite("admin@example.com", "viewer")).toBeUndefined()
    expect(
      database
        .prepare("SELECT role FROM access_grants WHERE email = ?")
        .get("admin@example.com")?.role
    ).toBe("admin")
  })
  it("does not count an unverified replacement as a usable admin", () => {
    invite("admin@example.com")
    signIn("admin@example.com")
    invite("pending@example.com")
    signIn("pending@example.com", 0)
    expect(invite("admin@example.com", "viewer")).toBeUndefined()
  })
  it("allows a verified replacement and protects them after the handover", () => {
    invite("admin@example.com")
    signIn("admin@example.com")
    invite("replacement@example.com")
    signIn("Replacement@Example.com")
    expect(
      database.prepare(revokeAccessSql).get("admin@example.com")
    ).toMatchObject({ email: "admin@example.com" })
    expect(invite("replacement@example.com", "viewer")).toBeUndefined()
  })
  it("allows removing or demoting pending invitations while keeping the working admin", () => {
    invite("admin@example.com")
    signIn("admin@example.com")
    invite("pending@example.com")
    expect(invite("pending@example.com", "viewer")).toMatchObject({
      role: "viewer",
    })
    invite("another@example.com")
    expect(
      database.prepare(revokeAccessSql).get("another@example.com")
    ).toMatchObject({ email: "another@example.com" })
  })
  it("rechecks the guard after each admin demotion", () => {
    for (const email of ["first@example.com", "second@example.com"]) {
      invite(email)
      signIn(email)
    }
    expect(invite("first@example.com", "viewer")).toMatchObject({
      role: "viewer",
    })
    expect(invite("second@example.com", "viewer")).toBeUndefined()
  })
  it("still protects the last pending admin grant", () => {
    invite("pending@example.com")
    expect(invite("pending@example.com", "viewer")).toBeUndefined()
    expect(
      database.prepare(revokeAccessSql).get("pending@example.com")
    ).toBeUndefined()
  })
})
