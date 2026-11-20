import { createFileRoute } from "@tanstack/react-router"
import { resolveReport } from "@/lib/api-context"
import { computeTimeseries } from "@/lib/timeseries"

export const Route = createFileRoute("/api/sites/$siteId/timeseries")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const ctx = await resolveReport(request, params.siteId)
        if (ctx instanceof Response) return ctx

        const points = await computeTimeseries(
          ctx.site,
          ctx.resolved,
          undefined,
          ctx.filters
        )
        return Response.json({ range: ctx.resolved, points })
      },
    },
  },
})
