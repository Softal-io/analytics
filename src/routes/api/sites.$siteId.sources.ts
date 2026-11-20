import { createFileRoute } from "@tanstack/react-router"
import type { SourceDimension } from "@/lib/top-lists"
import { resolveReport } from "@/lib/api-context"
import { computeTopSources } from "@/lib/top-lists"

export const Route = createFileRoute("/api/sites/$siteId/sources")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const ctx = await resolveReport(request, params.siteId)
        if (ctx instanceof Response) return ctx

        const view = new URL(request.url).searchParams.get("view")
        const dimension: SourceDimension =
          view === "links" || view === "utm" ? view : "referrer"
        const result = await computeTopSources(
          ctx.site,
          ctx.resolved,
          dimension,
          ctx.limit,
          undefined,
          ctx.filters
        )
        return Response.json({ range: ctx.resolved, ...result })
      },
    },
  },
})
