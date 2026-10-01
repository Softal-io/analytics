import { createFileRoute } from "@tanstack/react-router"
import { env } from "cloudflare:workers"
import { asc, eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { requireAdmin } from "@/lib/access"
import { grantAccessSql, revokeAccessSql } from "@/lib/access-grant-sql.js"
import { accessGrants, authUser, insertAccessGrantSchema } from "@/db/schema"

export const Route = createFileRoute("/api/admin/access")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await requireAdmin(request)
        const rows = await db
          .select({
            email: accessGrants.email,
            role: accessGrants.role,
            name: authUser.name,
            signedUp: authUser.createdAt,
          })
          .from(accessGrants)
          .leftJoin(authUser, eq(authUser.email, accessGrants.email))
          .orderBy(asc(accessGrants.email))
        return Response.json(rows)
      },
      PUT: async ({ request }) => {
        await requireAdmin(request)
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 })
        }
        const parsed = insertAccessGrantSchema
          .required()
          .strict()
          .safeParse(body)
        if (!parsed.success)
          return Response.json(
            { error: "Enter a valid email and role" },
            { status: 400 }
          )
        const { email, role } = parsed.data
        const changed = await env.DB.prepare(grantAccessSql)
          .bind(email, role)
          .first()
        return Response.json(
          changed ?? { error: "Keep at least one admin who has signed in" },
          {
            status: changed ? 200 : 409,
          }
        )
      },
      DELETE: async ({ request }) => {
        await requireAdmin(request)
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 })
        }
        const parsed = z
          .object({ email: insertAccessGrantSchema.shape.email })
          .strict()
          .safeParse(body)
        if (!parsed.success)
          return Response.json(
            { error: "Enter a valid email" },
            { status: 400 }
          )
        const removed = await env.DB.prepare(revokeAccessSql)
          .bind(parsed.data.email)
          .first()
        return removed
          ? new Response(null, { status: 204 })
          : Response.json(
              {
                error:
                  "Choose an existing email and keep an admin who has signed in",
              },
              { status: 409 }
            )
      },
    },
  },
})
