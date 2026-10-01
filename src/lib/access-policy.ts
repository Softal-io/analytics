import type { Principal } from "@/lib/access"

/** Server functions enforce their own permissions, including public loaders. */
export async function authorizeRequest(
  request: Request,
  readPrincipal: () => Promise<Principal | null>
): Promise<Response | null> {
  const url = new URL(request.url)
  const { origin } = url
  let pathname: string
  try {
    // Match the router's decoded, case-insensitive paths and optional trailing slash.
    pathname =
      decodeURI(url.pathname)
        .replace(/\/+/g, "/")
        .replace(/\/+$/, "")
        .toLowerCase() || "/"
  } catch {
    return Response.json({ error: "Invalid URL path" }, { status: 400 })
  }
  if (pathname === "/collect" || pathname === "/script.js") return null
  if (pathname.startsWith("/api/auth/")) return null
  const writing = !["GET", "HEAD", "OPTIONS"].includes(request.method)
  if (writing || request.headers.get("Upgrade") === "websocket") {
    const requestOrigin = request.headers.get("Origin")
    if (
      (requestOrigin && requestOrigin !== origin) ||
      request.headers.get("Sec-Fetch-Site") === "cross-site"
    ) {
      return Response.json(
        { error: "Cross-site requests are not allowed" },
        { status: 403 }
      )
    }
  }
  if (pathname.startsWith("/_serverfn/")) return null
  if (
    pathname === "/login" ||
    pathname.startsWith("/public/") ||
    pathname.startsWith("/api/public/")
  ) {
    return writing ? new Response(null, { status: 405 }) : null
  }
  const principal = await readPrincipal()
  if (!principal?.role) {
    if (!pathname.startsWith("/api/") && request.method === "GET") {
      return Response.redirect(new URL("/login", request.url), 302)
    }
    return Response.json(
      { error: principal ? "Access has not been granted" : "Sign in required" },
      { status: principal ? 403 : 401 }
    )
  }
  const adminOnly =
    writing ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/api/admin/") ||
    pathname.endsWith("/public-view")
  if (adminOnly && principal.role !== "admin") {
    return Response.json({ error: "Admin access required" }, { status: 403 })
  }
  return null
}
