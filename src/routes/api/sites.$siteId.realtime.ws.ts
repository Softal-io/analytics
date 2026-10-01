import { createFileRoute } from "@tanstack/react-router"
import { env } from "cloudflare:workers"
import { getAccessSession } from "@/lib/access"
import { REALTIME_SESSION_HEADER } from "@/lib/realtime-access"

/**
 * `GET /api/sites/:id/realtime/ws` — WebSocket upgrade, proxied straight
 * through to the site's `LiveVisitors` Durable Object (§11). The DO's
 * `fetch` handler does the actual `acceptWebSocket` + returns the
 * `101` response with the client-side end of the `WebSocketPair`.
 */
export const Route = createFileRoute("/api/sites/$siteId/realtime/ws")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("Expected a WebSocket upgrade", { status: 426 })
        }

        const access = await getAccessSession(request.headers)
        if (!access?.principal.role)
          return Response.json(
            { error: "Sign in with approved access" },
            { status: 403 }
          )
        const forwarded = new Request(request)
        // Overwrite any client-supplied value with the verified server-side session.
        forwarded.headers.set(REALTIME_SESSION_HEADER, access.sessionId)
        const stub = env.LIVE_VISITORS.getByName(params.siteId)
        return stub.fetch(forwarded)
      },
    },
  },
})
