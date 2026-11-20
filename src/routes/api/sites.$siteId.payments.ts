import { createFileRoute } from "@tanstack/react-router"
import { resolveReport } from "@/lib/api-context"
import { computePayments } from "@/lib/payments"

export const Route = createFileRoute("/api/sites/$siteId/payments")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const ctx = await resolveReport(request, params.siteId, 50)
        if (ctx instanceof Response) return ctx

        const result = await computePayments(
          ctx.site,
          ctx.resolved,
          ctx.filters,
          ctx.limit
        )
        return Response.json({ range: ctx.resolved, ...result })
      },
    },
  },
})
