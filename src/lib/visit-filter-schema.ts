import { z } from "zod"
import {
  MAX_RECORDED_PATH_CHARS,
  MAX_RECORDED_URL_CHARS,
} from "./analytics-config"

/**
 * Dashboard filters. Every filter selects visits; a filtered report then
 * describes those visits, whichever card the filter was chosen from.
 */
const text = (max: number) => z.string().min(1).max(max)
export const campaignKey = z.tuple([
  z.string().max(200),
  z.string().max(200),
  z.string().max(500),
])

export const visitFiltersSchema = z
  .object({
    /** Visits that viewed this path at any point. */
    page: text(MAX_RECORDED_PATH_CHARS),
    entry: text(MAX_RECORDED_PATH_CHARS),
    exit: text(MAX_RECORDED_PATH_CHARS),
    referrer: text(MAX_RECORDED_URL_CHARS),
    /** JSON `[source, medium, campaign]`, the key used by campaign rows. */
    utm: z
      .string()
      .max(1000)
      .refine((value) => {
        try {
          const parsed = campaignKey.safeParse(JSON.parse(value))
          return parsed.success && parsed.data.some(Boolean)
        } catch {
          return false
        }
      }),
    browser: text(100),
    os: text(100),
    device: text(100),
    country: text(8),
    region: text(200),
    city: text(200),
    /** Visits that clicked this outbound URL. */
    link: text(MAX_RECORDED_URL_CHARS),
    /** Visits that recorded this custom event. */
    event: text(200),
    /** Visits that led to a recorded payment. */
    paid: z.literal("1"),
  })
  .partial()

export type VisitFilters = z.infer<typeof visitFiltersSchema>
export type VisitFilterKey = keyof VisitFilters
export const visitFilterKeys = Object.keys(
  visitFiltersSchema.shape
) as Array<VisitFilterKey>

export function hasVisitFilters(filters?: VisitFilters): boolean {
  return Boolean(filters && visitFilterKeys.some((key) => filters[key]))
}

/** Reads filters from a query string. Returns null when a value is invalid. */
export function parseVisitFilters(
  params: URLSearchParams
): VisitFilters | undefined | null {
  const values: Record<string, string> = {}
  for (const key of visitFilterKeys) {
    const value = params.get(key)
    if (value !== null && value !== "") values[key] = value
  }
  if (Object.keys(values).length === 0) return undefined
  const parsed = visitFiltersSchema.safeParse(values)
  return parsed.success ? parsed.data : null
}

export function visitFilterQuery(filters?: VisitFilters): string {
  const params = new URLSearchParams()
  for (const key of visitFilterKeys) {
    const value = filters?.[key]
    if (value) params.set(key, value)
  }
  const query = params.toString()
  return query ? `&${query}` : ""
}
