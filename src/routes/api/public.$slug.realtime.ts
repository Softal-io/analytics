import { createFileRoute } from "@tanstack/react-router"
import { loadPublicRealtime, loadPublicView } from "@/lib/public-data"

export const Route = createFileRoute("/api/public/$slug/realtime")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const view = await loadPublicView(params.slug)
        if (!view?.settings.sections.includes("realtime"))
          return Response.json({ error: "Not found" }, { status: 404 })
        const realtime = await loadPublicRealtime(view)
        return Response.json(realtime, {
          headers: { "Cache-Control": "no-store" },
        })
      },
    },
  },
})
