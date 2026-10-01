import handler from "@tanstack/react-start/server-entry"
import { runDailyAggregation } from "@/lib/aggregate"
import { handleExternalApi } from "@/lib/external-api"
import { authorizeDashboard } from "@/lib/dashboard-auth"

export { LiveVisitors } from "@/durable-objects/live-visitors"

export default {
  async fetch(request: Request): Promise<Response> {
    // `/ext/v1/*` is the bearer-authed, read-only external API (see
    // src/lib/external-api.ts). It's handled ahead of the app router so the
    // auth check can't be routed around, and returns null for every other
    // path so normal requests fall through untouched.
    const external = await handleExternalApi(request)
    if (external) return external

    const unauthorized = await authorizeDashboard(request)
    if (unauthorized) return unauthorized

    // TanStack Start reads bindings from `cloudflare:workers`, so the
    // handler takes the request alone — env/ctx aren't forwarded.
    const response = await handler.fetch(request)
    if (response.status !== 101)
      response.headers.set("Cache-Control", "no-store")
    return response
  },

  // Daily rollup cron (§7) — see wrangler.jsonc `triggers.crons`.
  async scheduled(
    _event: ScheduledController,
    _env: Env,
    ctx: ExecutionContext
  ) {
    ctx.waitUntil(runDailyAggregation())
  },
}
