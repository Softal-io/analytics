import { createFileRoute } from "@tanstack/react-router"
import type { LocationDimension } from "@/lib/top-lists"
import { resolveReport } from "@/lib/api-context"
import { computeTopLocations } from "@/lib/top-lists"

export const Route = createFileRoute("/api/sites/$siteId/locations")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const ctx = await resolveReport(request, params.siteId)
        if (ctx instanceof Response) return ctx

        const view = new URL(request.url).searchParams.get("view")
        const dimension: LocationDimension =
          view === "region" || view === "city" ? view : "country"
        const result = await computeTopLocations(
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
