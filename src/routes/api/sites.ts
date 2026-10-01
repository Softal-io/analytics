import { createFileRoute } from "@tanstack/react-router"
import { asc } from "drizzle-orm"
import { db } from "@/db"
import { insertSiteSchema, sites } from "@/db/schema"

/**
 * `GET  /api/sites` — list all sites (dashboard site switcher).
 * `POST /api/sites` — create a new site.
 *
 * The Worker checks viewer access for reads and admin access for writes.
 */
export const Route = createFileRoute("/api/sites")({
  server: {
    handlers: {
      GET: async () => {
        const rows = await db.select().from(sites).orderBy(asc(sites.name))
        return Response.json(rows)
      },

      POST: async ({ request }) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 })
        }

        const parsed = insertSiteSchema.safeParse(body)
        if (!parsed.success) {
          return Response.json(
            { error: "Validation failed", issues: parsed.error.issues },
            { status: 400 },
          )
        }

        const [created] = await db
          .insert(sites)
          .values({
            id: crypto.randomUUID(),
            name: parsed.data.name,
            domain: parsed.data.domain,
            timezone: parsed.data.timezone ?? "UTC",
            createdAt: Math.floor(Date.now() / 1000),
          })
          .returning()

        return Response.json(created, { status: 201 })
      },
    },
  },
})
