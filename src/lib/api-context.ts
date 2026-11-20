import { eq } from "drizzle-orm"
import type { ResolvedRange } from "@/lib/dates"
import type { VisitFilters } from "@/lib/visit-filter-schema"
import { db } from "@/db"
import { sites } from "@/db/schema"
import { isRangeKey, resolveRange } from "@/lib/dates"
import { parseVisitFilters } from "@/lib/visit-filter-schema"

export interface ApiContext {
  site: typeof sites.$inferSelect
  resolved: ResolvedRange
}

export interface ReportContext extends ApiContext {
  /** Present only when the request filters the report to matching visits. */
  filters?: VisitFilters
  /** Rows to return from a ranked list. */
  limit: number
}

const MAX_LIST_ROWS = 200

/**
 * Shared setup for every `/api/sites/:id/...` handler: load the site (404
 * if missing) and resolve `?range=` (+ `?from=`/`?to=` for custom) into
 * concrete dates using the site's own timezone.
 */
export async function resolveSiteAndRange(
  request: Request,
  siteId: string
): Promise<ApiContext | null> {
  const [site] = await db
    .select()
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1)
  if (!site) return null

  const url = new URL(request.url)
  const rangeParam = url.searchParams.get("range")
  const range = isRangeKey(rangeParam) ? rangeParam : "30d"
  const from = url.searchParams.get("from")
  const to = url.searchParams.get("to")
  const resolved = resolveRange(range, site.timezone, from, to)

  return { site, resolved }
}

/**
 * Setup for report handlers, which also accept visit filters and `?limit=`.
 * Returns the error response when the site or a filter is not usable: a
 * silently dropped filter would present unfiltered numbers as filtered.
 */
export async function resolveReport(
  request: Request,
  siteId: string,
  defaultLimit = 10
): Promise<ReportContext | Response> {
  const params = new URL(request.url).searchParams
  const filters = parseVisitFilters(params)
  if (filters === null)
    return Response.json({ error: "Invalid filter" }, { status: 400 })
  const context = await resolveSiteAndRange(request, siteId)
  if (!context)
    return Response.json({ error: "Site not found" }, { status: 404 })
  const requested = Number(params.get("limit"))
  const limit =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, MAX_LIST_ROWS)
      : defaultLimit
  return { ...context, filters, limit }
}
