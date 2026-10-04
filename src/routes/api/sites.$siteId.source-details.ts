import { createFileRoute } from "@tanstack/react-router"
import { resolveSiteAndRange } from "@/lib/api-context"
import {
  loadSourceUrlDetails,
  sourceDetailsRequestSchema,
} from "@/lib/source-url-details"

export const Route = createFileRoute("/api/sites/$siteId/source-details")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const parsed = sourceDetailsRequestSchema.safeParse(
          Object.fromEntries(new URL(request.url).searchParams)
        )
        if (!parsed.success)
          return Response.json({ error: "Invalid source" }, { status: 400 })
        const context = await resolveSiteAndRange(request, params.siteId)
        if (!context)
          return Response.json({ error: "Site not found" }, { status: 404 })
        const details = await loadSourceUrlDetails(
          context.site,
          context.resolved,
          parsed.data
        )
        return Response.json(details ?? { error: "Source not found" }, {
          status: details ? 200 : 404,
          headers: { "Cache-Control": "no-store" },
        })
      },
    },
  },
})
