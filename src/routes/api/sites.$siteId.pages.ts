import { createFileRoute } from "@tanstack/react-router"
import type { PageDimension } from "@/lib/top-lists"
import { resolveReport } from "@/lib/api-context"
import { computeTopPages } from "@/lib/top-lists"

export const Route = createFileRoute("/api/sites/$siteId/pages")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const ctx = await resolveReport(request, params.siteId)
        if (ctx instanceof Response) return ctx

        const view = new URL(request.url).searchParams.get("view")
        const dimension: PageDimension =
          view === "entered" || view === "exited" ? view : "top"
        const result = await computeTopPages(
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
