import { createFileRoute } from "@tanstack/react-router"
import { loadPublicSnapshot } from "@/lib/public-data"
import { isRangeKey } from "@/lib/dates"

export const Route = createFileRoute("/api/public/$slug")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const value = new URL(request.url).searchParams.get("range")
        const range = isRangeKey(value) && value !== "custom" ? value : "30d"
        const snapshot = await loadPublicSnapshot(params.slug, range)
        return Response.json(snapshot ?? { error: "Not found" }, {
          status: snapshot ? 200 : 404,
          headers: { "Cache-Control": "no-store" },
        })
      },
    },
  },
})
