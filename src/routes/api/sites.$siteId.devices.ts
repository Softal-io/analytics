import { createFileRoute } from "@tanstack/react-router"
import type { DeviceDimension } from "@/lib/top-lists"
import { resolveReport } from "@/lib/api-context"
import { computeTopDevices } from "@/lib/top-lists"

export const Route = createFileRoute("/api/sites/$siteId/devices")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const ctx = await resolveReport(request, params.siteId)
        if (ctx instanceof Response) return ctx

        const view = new URL(request.url).searchParams.get("view")
        const dimension: DeviceDimension =
          view === "os" || view === "device" ? view : "browser"
        const result = await computeTopDevices(
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
