import { createFileRoute } from "@tanstack/react-router"
import { resolveReport } from "@/lib/api-context"
import { computePreviousSummary, computeSummary } from "@/lib/summary"

export const Route = createFileRoute("/api/sites/$siteId/summary")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const ctx = await resolveReport(request, params.siteId)
        if (ctx instanceof Response) return ctx

        const compare =
          new URL(request.url).searchParams.get("compare") === "previous"
        const [summary, previous] = await Promise.all([
          computeSummary(ctx.site, ctx.resolved, undefined, ctx.filters),
          compare
            ? computePreviousSummary(ctx.site, ctx.resolved, ctx.filters)
            : undefined,
        ])
        return Response.json({ range: ctx.resolved, ...summary, previous })
      },
    },
  },
})
