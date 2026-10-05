import handler from "@tanstack/react-start/server-entry"
import { runDailyAggregation } from "@/lib/aggregate"
import { handleExternalApi } from "@/lib/external-api"
import { authorizeDashboard } from "@/lib/dashboard-auth"

export { LiveVisitors } from "@/durable-objects/live-visitors"

function preventIndexing(response: Response): Response {
  // Preserve the WebSocket upgrade and its attached socket.
  if (response.status === 101) return response

  // Redirects and upstream responses can have immutable headers.
  const protectedResponse = new Response(response.body, response)
  protectedResponse.headers.set(
    "X-Robots-Tag",
    "noindex, nofollow, noarchive, nosnippet"
  )
  protectedResponse.headers.set("Cache-Control", "no-store")
  return protectedResponse
}

export default {
  async fetch(request: Request): Promise<Response> {
    // `/ext/v1/*` is the bearer-authed, read-only external API (see
    // src/lib/external-api.ts). It's handled ahead of the app router so the
    // auth check can't be routed around, and returns null for every other
    // path so normal requests fall through untouched.
    const external = await handleExternalApi(request)
    if (external) return preventIndexing(external)

    const unauthorized = await authorizeDashboard(request)
    if (unauthorized) return preventIndexing(unauthorized)

    // TanStack Start reads bindings from `cloudflare:workers`, so the
    // handler takes the request alone — env/ctx aren't forwarded.
    const response = await handler.fetch(request)
    return preventIndexing(response)
  },

  // Bounded hourly rollup cron — see wrangler.jsonc `triggers.crons`.
  async scheduled(
    _event: ScheduledController,
    _env: Env,
    ctx: ExecutionContext
  ) {
    ctx.waitUntil(runDailyAggregation())
  },
}
