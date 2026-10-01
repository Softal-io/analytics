import { describe, expect, it, vi } from "vitest"
import type { Principal } from "@/lib/access"
import { authorizeRequest } from "@/lib/access-policy"

const admin: Principal = {
  id: "1",
  name: "Admin",
  email: "admin@example.com",
  role: "admin",
}
const request = (path: string, method = "GET", headers?: HeadersInit) =>
  new Request(`https://analytics.example.com${path}`, { method, headers })
const principal = (role: Principal["role"]) => () =>
  Promise.resolve({ ...admin, role })

describe("analytics access", () => {
  it("redirects anonymous dashboard visits to sign-in and rejects private API reads", async () => {
    const read = () => Promise.resolve(null)
    expect(
      (await authorizeRequest(request("/"), read))?.headers.get("Location")
    ).toBe("https://analytics.example.com/login")
    expect((await authorizeRequest(request("/api/sites"), read))?.status).toBe(
      401
    )
  })
  it("requires an explicit email grant even with a verified session", async () => {
    expect(
      (await authorizeRequest(request("/api/sites"), principal(null)))?.status
    ).toBe(403)
  })
  it("lets viewers read private data but rejects all site writes and administration", async () => {
    expect(
      await authorizeRequest(
        request("/api/sites/site/summary"),
        principal("viewer")
      )
    ).toBeNull()
    for (const [path, method] of [
      ["/api/sites", "POST"],
      ["/api/sites/site", "DELETE"],
      ["/api/sites/site/public-view", "GET"],
      ["/api/admin/access", "GET"],
      ["/admin/users", "GET"],
    ]) {
      expect(
        (await authorizeRequest(request(path, method), principal("viewer")))
          ?.status
      ).toBe(403)
    }
  })
  it.each([
    "/api/%61dmin/access",
    "/%61pi/admin/access",
    "/api/admin/access/",
    "/API/ADMIN/ACCESS",
    "/api//admin/access",
    "/api/sites/site/public-view/",
    "/api/sites/site/%70ublic-view",
    "/api/sites/site/PUBLIC-VIEW",
    "/%61dmin/users/",
  ])("checks admin permissions for the router alias %s", async (path) => {
    expect(
      (await authorizeRequest(request(path), principal("viewer")))?.status
    ).toBe(403)
    expect(await authorizeRequest(request(path), principal("admin"))).toBeNull()
    expect(
      (await authorizeRequest(request(path), () => Promise.resolve(null)))
        ?.status
    ).not.toBeUndefined()
  })
  it("rejects malformed encoding without consulting the session", async () => {
    const read = vi.fn()
    expect(
      (await authorizeRequest(request("/api/%ZZadmin/access"), read))?.status
    ).toBe(400)
    expect(read).not.toHaveBeenCalled()
  })
  it("allows admins to manage websites and access", async () => {
    expect(
      await authorizeRequest(request("/api/sites", "POST"), principal("admin"))
    ).toBeNull()
    expect(
      await authorizeRequest(request("/api/admin/access"), principal("admin"))
    ).toBeNull()
  })
  it("blocks cross-origin writes and private websocket connections", async () => {
    const crossSiteHeaders: Array<HeadersInit> = [
      { Origin: "https://evil.example" },
      { "Sec-Fetch-Site": "cross-site" },
    ]
    for (const headers of crossSiteHeaders) {
      expect(
        (
          await authorizeRequest(
            request("/api/sites", "POST", headers),
            principal("admin")
          )
        )?.status
      ).toBe(403)
    }
    expect(
      (
        await authorizeRequest(
          request("/api/sites/site/realtime/ws", "GET", {
            Upgrade: "websocket",
            Origin: "https://evil.example",
          }),
          principal("admin")
        )
      )?.status
    ).toBe(403)
  })
  it("leaves the collector, login, and public read routes accessible without reading sessions", async () => {
    const read = vi.fn()
    for (const path of [
      "/collect",
      "/script.js",
      "/login",
      "/public/site",
      "/api/public/site",
      "/api/public/site/realtime",
      "/api/auth/get-session",
      "/%70ublic/site/",
      "/%61pi/public/site/",
    ]) {
      expect(await authorizeRequest(request(path), read)).toBeNull()
    }
    expect(read).not.toHaveBeenCalled()
  })
  it("leaves server function permissions to their handlers", async () => {
    const read = vi.fn()
    expect(
      await authorizeRequest(request("/_serverFn/public-loader", "POST"), read)
    ).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
  it("does not allow unauthenticated writes to public views", async () => {
    expect(
      (
        await authorizeRequest(request("/api/public/site", "PUT"), () =>
          Promise.resolve(null)
        )
      )?.status
    ).toBe(405)
  })
})
