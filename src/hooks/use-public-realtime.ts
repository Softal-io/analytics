import { useEffect, useState } from "react"
import { z } from "zod"
import type { RealtimeVisitorLocation } from "@/lib/realtime"

const pollDelay = 20_000
const requestTimeout = 10_000
const realtimeSchema = z.object({
  count: z.number().int().nonnegative(),
  locations: z
    .array(
      z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        count: z.number().int().nonnegative(),
      })
    )
    .optional(),
})

interface PublicRealtimeState {
  count: number | undefined
  locations: Array<RealtimeVisitorLocation> | undefined
  unavailable: boolean
}

export function usePublicRealtime(
  slug: string,
  initialCount: number | undefined,
  initialLocations: Array<RealtimeVisitorLocation> | undefined
): PublicRealtimeState {
  const [state, setState] = useState<PublicRealtimeState>({
    count: initialCount,
    locations: initialLocations,
    unavailable: false,
  })

  useEffect(() => {
    setState({
      count: initialCount,
      locations: initialLocations,
      unavailable: false,
    })
    if (initialCount === undefined) return

    let cancelled = false
    let withdrawn = false
    let controller: AbortController | undefined
    let timer: number
    let timeout: number | undefined

    async function poll() {
      controller = new AbortController()
      timeout = window.setTimeout(() => controller?.abort(), requestTimeout)
      try {
        const response = await fetch(
          `/api/public/${encodeURIComponent(slug)}/realtime`,
          { signal: controller.signal }
        )
        if (cancelled) return
        if (response.status === 404 || response.status === 410) {
          withdrawn = true
          setState({
            count: undefined,
            locations: undefined,
            unavailable: false,
          })
          return
        }
        if (!response.ok) throw new Error("Live updates unavailable")
        const data = realtimeSchema.parse(await response.json())
        if (controller.signal.aborted) return
        setState({
          count: data.count,
          locations: data.locations,
          unavailable: false,
        })
      } catch {
        if (!cancelled)
          setState((previous) => ({ ...previous, unavailable: true }))
      } finally {
        window.clearTimeout(timeout)
        if (!cancelled && !withdrawn)
          timer = window.setTimeout(() => void poll(), pollDelay)
      }
    }

    timer = window.setTimeout(() => void poll(), pollDelay)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearTimeout(timeout)
      controller?.abort()
    }
  }, [slug, initialCount, initialLocations])

  return state
}
