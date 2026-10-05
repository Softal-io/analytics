import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  external: vi.fn(),
  authorize: vi.fn(),
}))

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: mocks.fetch },
}))
vi.mock("@/lib/external-api", () => ({ handleExternalApi: mocks.external }))
vi.mock("@/lib/dashboard-auth", () => ({
  authorizeDashboard: mocks.authorize,
}))
vi.mock("@/lib/aggregate", () => ({ runDailyAggregation: vi.fn() }))
vi.mock("@/durable-objects/live-visitors", () => ({ LiveVisitors: class {} }))

import worker from "./server"

beforeEach(() => {
  vi.resetAllMocks()
  mocks.external.mockResolvedValue(null)
  mocks.authorize.mockResolvedValue(null)
})

describe("Worker indexing policy", () => {
  it.each(["/", "/login", "/public/shared", "/api/public/shared", "/missing"])(
    "prevents indexing of routed responses at %s",
    async (path) => {
      mocks.fetch.mockResolvedValue(new Response("page", { status: 200 }))
      const response = await worker.fetch(
        new Request(`https://analytics.example.com${path}`)
      )
      expect(response.headers.get("X-Robots-Tag")).toBe(
        "noindex, nofollow, noarchive, nosnippet"
      )
      expect(response.headers.get("Cache-Control")).toBe("no-store")
      expect(await response.text()).toBe("page")
    }
  )

  it("handles immutable sign-in redirects before the router", async () => {
    mocks.authorize.mockResolvedValue(
      Response.redirect("https://analytics.example.com/login", 302)
    )
    const response = await worker.fetch(
      new Request("https://analytics.example.com/")
    )
    expect(response.status).toBe(302)
    expect(response.headers.get("Location")).toBe(
      "https://analytics.example.com/login"
    )
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex")
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it("covers denied private APIs and external API responses", async () => {
    const request = new Request("https://analytics.example.com/api/sites")
    mocks.authorize.mockResolvedValue(
      Response.json({ error: "Sign in required" }, { status: 401 })
    )
    const denied = await worker.fetch(request)
    expect(denied.status).toBe(401)
    expect(denied.headers.get("X-Robots-Tag")).toContain("noindex")

    mocks.external.mockResolvedValue(
      Response.json(
        { sites: [] },
        { headers: { "Access-Control-Allow-Origin": "*" } }
      )
    )
    const external = await worker.fetch(
      new Request("https://analytics.example.com/ext/v1/sites")
    )
    expect(external.headers.get("X-Robots-Tag")).toContain("noindex")
    expect(external.headers.get("Access-Control-Allow-Origin")).toBe("*")
    expect(await external.json()).toEqual({ sites: [] })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it("preserves authentication cookies and other response headers", async () => {
    const upstream = new Response(null, { status: 204 })
    upstream.headers.append("Set-Cookie", "session=abc; HttpOnly; Secure")
    upstream.headers.append("Set-Cookie", "state=xyz; HttpOnly; Secure")
    mocks.fetch.mockResolvedValue(upstream)
    const response = await worker.fetch(
      new Request("https://analytics.example.com/api/auth/callback/google")
    )
    expect(response.status).toBe(204)
    expect(response.headers.getSetCookie()).toEqual(
      upstream.headers.getSetCookie()
    )
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex")
  })

  it("returns WebSocket upgrades without rebuilding the response", async () => {
    const upgraded = { status: 101, webSocket: {} } as unknown as Response
    mocks.fetch.mockResolvedValue(upgraded)
    expect(
      await worker.fetch(
        new Request("https://analytics.example.com/api/sites/site/realtime/ws")
      )
    ).toBe(upgraded)
  })
})
