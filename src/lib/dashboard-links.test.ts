import { describe, expect, it } from "vitest"
import { externalUrl, pageUrl, referrerUrl } from "./dashboard-links"

describe("dashboard navigation URLs", () => {
  it("preserves outbound schemes, paths, and query strings", () => {
    expect(externalUrl("http://vendor.example/Offer?ref=abc#details")).toBe(
      "http://vendor.example/Offer?ref=abc#details"
    )
    expect(externalUrl("javascript:alert(1)")).toBeUndefined()
    expect(externalUrl("data:text/html,hello")).toBeUndefined()
    expect(externalUrl("https://user:password@vendor.example")).toBeUndefined()
  })

  it("links referrer hostnames but leaves attribution labels alone", () => {
    expect(referrerUrl("google.com")).toBe("https://google.com/")
    for (const label of [
      "Direct",
      "Unknown",
      "(direct)",
      "(unknown)",
      "newsletter / email",
    ]) {
      expect(referrerUrl(label)).toBeUndefined()
    }
  })

  it("resolves page paths on the selected site and prevents origin escapes", () => {
    expect(pageUrl("fixture.example", "/offers")).toBe(
      "https://fixture.example/offers"
    )
    expect(pageUrl("http://localhost:3006", "/offers?q=demo")).toBe(
      "http://localhost:3006/offers?q=demo"
    )
    expect(pageUrl("fixture.example", "//other.example/path")).toBeUndefined()
    expect(pageUrl("fixture.example", "/\\other.example/path")).toBeUndefined()
    expect(pageUrl("fixture.example", "javascript:alert(1)")).toBeUndefined()
    expect(
      pageUrl("fixture.example", "Page path exceeds recording limit")
    ).toBeUndefined()
  })
})
