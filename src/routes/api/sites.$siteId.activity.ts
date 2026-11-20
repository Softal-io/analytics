import { createFileRoute } from "@tanstack/react-router"
import { resolveReport } from "@/lib/api-context"
import { computeEventList } from "@/lib/top-lists"

export const Route = createFileRoute("/api/sites/$siteId/activity")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const ctx = await resolveReport(request, params.siteId)
        if (ctx instanceof Response) return ctx

        const result = await computeEventList(
          ctx.site,
          ctx.resolved,
          ctx.limit,
          undefined,
          ctx.filters
        )
        return Response.json({ range: ctx.resolved, ...result })
      },
    },
  },
})
