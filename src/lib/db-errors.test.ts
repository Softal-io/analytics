import { DrizzleQueryError } from "drizzle-orm/errors"
import { describe, expect, it } from "vitest"
import { isUniqueConstraintError } from "./db-errors"

describe("public URL conflicts", () => {
  it("recognizes nested Drizzle and D1 uniqueness errors", () => {
    const cause = new Error(
      "D1_ERROR: UNIQUE constraint failed: site_public_views.slug: SQLITE_CONSTRAINT"
    )
    const error = new DrizzleQueryError(
      "insert into site_public_views",
      [],
      new Error("Database operation failed", { cause })
    )
    expect(String(error)).not.toContain("UNIQUE constraint")
    expect(isUniqueConstraintError(error, "site_public_views.slug")).toBe(true)
  })
  it("does not mislabel other database failures as URL conflicts", () => {
    for (const error of [
      new Error("FOREIGN KEY constraint failed"),
      new Error("UNIQUE constraint failed: auth_user.email"),
      new Error("Database unavailable"),
      null,
    ])
      expect(isUniqueConstraintError(error, "site_public_views.slug")).toBe(
        false
      )
  })
  it("stops when an error cause is cyclic", () => {
    const error = new Error("Database unavailable")
    error.cause = error
    expect(isUniqueConstraintError(error, "site_public_views.slug")).toBe(false)
  })
})
