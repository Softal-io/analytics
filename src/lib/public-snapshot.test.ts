import { describe, expect, it } from "vitest"
import { publicLocationLabel, selectPublicMetrics } from "@/lib/public-snapshot"
import { insertSitePublicViewSchema } from "@/db/schema"

describe("public analytics privacy", () => {
  it("requires city sharing and live counts before the globe can be published", () => {
    const settings = { slug: "fixture", enabled: true, metrics: [] }
    for (const sections of [
      ["realtimeGlobe"],
      ["countries", "realtime", "realtimeGlobe"],
      ["regions", "realtime", "realtimeGlobe"],
      ["cities", "realtimeGlobe"],
    ]) {
      expect(
        insertSitePublicViewSchema.safeParse({ ...settings, sections }).success
      ).toBe(false)
    }
    expect(
      insertSitePublicViewSchema.safeParse({
        ...settings,
        sections: ["cities", "realtime", "realtimeGlobe"],
      }).success
    ).toBe(true)
    expect(
      insertSitePublicViewSchema.safeParse({
        ...settings,
        sections: ["countries", "realtime"],
      }).success
    ).toBe(true)
  })
  it("does not expose unchecked overview metrics", () => {
    const summary = {
      visitors: 40,
      visits: 55,
      pageviews: 90,
      bounceRate: 0.3,
      avgDurationSeconds: 99,
      secret: "private",
    }
    expect(selectPublicMetrics(["visitors", "pageviews"], summary)).toEqual({
      visitors: 40,
      pageviews: 90,
    })
    expect(selectPublicMetrics([], summary)).toEqual({})
  })
  it("does not expose cities or regions when only countries are selected", () => {
    const row = { country: "IE", region: "Leinster", city: "Dublin" }
    expect(publicLocationLabel("countries", row)).toBe("Ireland")
    expect(publicLocationLabel("regions", row)).toBe("Leinster, Ireland")
    expect(publicLocationLabel("cities", row)).toBe("Dublin, Ireland")
  })
  it("rejects unknown sharing fields, invalid URLs, and empty enabled views", () => {
    const settings = {
      slug: "apps-deals",
      enabled: true,
      metrics: ["visitors"],
      sections: ["chart"],
    }
    expect(insertSitePublicViewSchema.safeParse(settings).success).toBe(true)
    for (const invalid of [
      { ...settings, slug: "../../admin" },
      { ...settings, metrics: ["password"] },
      { ...settings, sections: ["sessions"] },
      { ...settings, siteId: "foreign-site" },
      { ...settings, metrics: [], sections: [] },
    ]) {
      expect(insertSitePublicViewSchema.safeParse(invalid).success).toBe(false)
    }
    expect(
      insertSitePublicViewSchema.safeParse({
        ...settings,
        enabled: false,
        metrics: [],
        sections: [],
      }).success
    ).toBe(true)
  })
})
