import { createFileRoute } from "@tanstack/react-router"
import { env } from "cloudflare:workers"
import { loadPublicView } from "@/lib/public-data"

export const Route = createFileRoute("/api/public/$slug/realtime")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const view = await loadPublicView(params.slug)
        if (!view?.settings.sections.includes("realtime"))
          return Response.json({ error: "Not found" }, { status: 404 })
        const count = await env.LIVE_VISITORS.get(
          env.LIVE_VISITORS.idFromName(view.site.id)
        ).count()
        return Response.json(
          { count },
          { headers: { "Cache-Control": "no-store" } }
        )
      },
    },
  },
})
