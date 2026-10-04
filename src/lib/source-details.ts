import { z } from "zod"

export interface SourceLink {
  url: string
  kind: "referrer" | "landing"
  visits: number
}

export interface SourceDetails {
  referrerDomain?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  links: Array<SourceLink>
  linkCount: number
  hasMore?: boolean
  updatedAt?: number
}

export const sourceDetailsSchema: z.ZodType<SourceDetails> = z.object({
  referrerDomain: z.string().optional(),
  utmSource: z.string().optional(),
  utmMedium: z.string().optional(),
  utmCampaign: z.string().optional(),
  links: z.array(
    z.object({
      url: z.string(),
      kind: z.enum(["referrer", "landing"]),
      visits: z.number().int().nonnegative(),
    })
  ),
  linkCount: z.number().int().nonnegative(),
  hasMore: z.boolean().optional(),
  updatedAt: z.number().int().positive().optional(),
})
