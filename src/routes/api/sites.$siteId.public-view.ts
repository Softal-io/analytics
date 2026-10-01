import { createFileRoute } from "@tanstack/react-router"
import { env } from "cloudflare:workers"
import { eq } from "drizzle-orm"
import { db } from "@/db"
import { requireAdmin } from "@/lib/access"
import { isUniqueConstraintError } from "@/lib/db-errors"
import { insertSitePublicViewSchema, sitePublicViews, sites } from "@/db/schema"

export const Route = createFileRoute("/api/sites/$siteId/public-view")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        await requireAdmin(request)
        const site = await db
          .select()
          .from(sites)
          .where(eq(sites.id, params.siteId))
          .get()
        if (!site) return Response.json({ error: "Not found" }, { status: 404 })
        const settings = await db
          .select()
          .from(sitePublicViews)
          .where(eq(sitePublicViews.siteId, site.id))
          .get()
        const fallback = {
          slug: site.domain.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
          enabled: false,
          metrics: ["visitors", "pageviews"],
          sections: ["chart"],
        }
        return Response.json(settings ?? fallback)
      },
      PUT: async ({ request, params }) => {
        await requireAdmin(request)
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 })
        }
        const parsed = insertSitePublicViewSchema.safeParse(body)
        if (!parsed.success)
          return Response.json(
            {
              error: "Check the URL and select at least one item to publish",
              issues: parsed.error.issues,
            },
            { status: 400 }
          )
        const site = await db
          .select({ id: sites.id })
          .from(sites)
          .where(eq(sites.id, params.siteId))
          .get()
        if (!site) return Response.json({ error: "Not found" }, { status: 404 })
        const settings = {
          ...parsed.data,
          metrics: [...new Set(parsed.data.metrics)],
          sections: [...new Set(parsed.data.sections)],
          updatedAt: Math.floor(Date.now() / 1000),
        }
        try {
          await db
            .insert(sitePublicViews)
            .values({ siteId: site.id, ...settings })
            .onConflictDoUpdate({
              target: sitePublicViews.siteId,
              set: settings,
            })
        } catch (error) {
          if (isUniqueConstraintError(error, "site_public_views.slug"))
            return Response.json(
              { error: "That public URL is already in use" },
              { status: 409 }
            )
          throw error
        }
        return Response.json({
          ...settings,
          publicUrl: `${new URL(env.TRACKER_ORIGIN).origin}/public/${settings.slug}`,
        })
      },
    },
  },
})
