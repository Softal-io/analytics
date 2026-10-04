import { useCallback, useEffect, useRef, useState } from "react"
import type { SourceDetails } from "@/lib/source-details"
import { sourceDetailsSchema } from "@/lib/source-details"
import { SOURCE_DETAILS_CACHE_SECONDS } from "@/lib/analytics-config"

interface Result {
  details?: SourceDetails
  error?: string
  expiresAt: number
}
const cache = new Map<string, Result>()
const requests = new Map<string, Promise<void>>()

/** Rankings are fetched only after opening a tooltip, then reused in memory. */
export function useSourceDetails(baseUrl?: string) {
  const [, render] = useState(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const urlFor = useCallback(
    (key: string, view: "referrer" | "utm") =>
      baseUrl ? `${baseUrl}&${new URLSearchParams({ key, view })}` : undefined,
    [baseUrl]
  )
  const load = useCallback(
    async (key: string, view: "referrer" | "utm", force = false) => {
      const url = urlFor(key, view)
      if (!url) return
      if (!force && (cache.get(url)?.expiresAt ?? 0) > Date.now()) return
      let request = requests.get(url)
      if (!request) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10000)
        request = fetch(url, { signal: controller.signal })
          .then(async (response) => {
            if (!response.ok) throw new Error("URL details unavailable")
            const details = sourceDetailsSchema.parse(await response.json())
            const ttl = SOURCE_DETAILS_CACHE_SECONDS * 1000
            cache.set(url, {
              details,
              // Reusing a server cache entry must not restart its freshness window.
              expiresAt: Math.min(
                Date.now() + ttl,
                typeof details.updatedAt === "number"
                  ? details.updatedAt * 1000 + ttl
                  : Infinity
              ),
            })
            if (cache.size > 200) cache.delete(cache.keys().next().value!)
          })
          .catch(() => {
            cache.set(url, {
              error: "Could not load URL details.",
              expiresAt: 0,
            })
          })
          .finally(() => {
            clearTimeout(timeout)
            requests.delete(url)
          })
        requests.set(url, request)
      }
      if (mounted.current) render((value) => value + 1)
      await request
      if (mounted.current) render((value) => value + 1)
    },
    [urlFor]
  )

  return {
    load,
    get(key: string, view: "referrer" | "utm", initial: SourceDetails) {
      const url = urlFor(key, view)
      const result = url ? cache.get(url) : undefined
      return {
        details: result?.details ?? initial,
        loading: Boolean(url && requests.has(url)),
        error: result?.error,
        retry: () => void load(key, view, true),
      }
    },
  }
}
