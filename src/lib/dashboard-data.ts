import { env } from "cloudflare:workers"
import { asc } from "drizzle-orm"
import { db } from "@/db"
import { sites } from "@/db/schema"
import { requireViewer } from "@/lib/access"

export async function loadDashboardData() {
  const user = await requireViewer()
  return {
    sites: await db.select().from(sites).orderBy(asc(sites.name)).all(),
    trackerOrigin: new URL(env.TRACKER_ORIGIN).origin,
    user,
  }
}
