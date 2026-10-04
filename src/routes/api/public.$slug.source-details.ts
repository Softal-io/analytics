import { createFileRoute } from "@tanstack/react-router"
import { loadPublicSourceDetails } from "@/lib/public-data"
import { isRangeKey } from "@/lib/dates"
import { sourceDetailsRequestSchema } from "@/lib/source-url-details"

export const Route = createFileRoute("/api/public/$slug/source-details")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const search = new URL(request.url).searchParams
        const parsed = sourceDetailsRequestSchema.safeParse(
          Object.fromEntries(search)
        )
        if (!parsed.success)
          return Response.json({ error: "Invalid source" }, { status: 400 })
        const value = search.get("range")
        const range = isRangeKey(value) && value !== "custom" ? value : "30d"
        const details = await loadPublicSourceDetails(
          params.slug,
          range,
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
