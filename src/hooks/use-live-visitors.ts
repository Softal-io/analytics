import { useEffect, useState } from "react"
import { z } from "zod"
import type { RealtimeVisitorsPayload } from "@/lib/realtime"

const payloadSchema = z.object({
  count: z.number().int().nonnegative(),
  locations: z.array(
    z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      count: z.number().int().nonnegative(),
    })
  ),
})
const staleAfterMs = 90_000 // The server rebroadcasts once a minute, even when the count is unchanged.

/** Hide old activity as soon as a connection fails or stops delivering updates. */
export function useLiveVisitors(siteId: string | undefined) {
  const [state, setState] = useState<{
    siteId?: string
    count: number | null
    locations: RealtimeVisitorsPayload["locations"]
    unavailable: boolean
  }>({ count: null, locations: [], unavailable: false })
  useEffect(() => {
    if (!siteId) return
    setState({ siteId, count: null, locations: [], unavailable: false })
    let cancelled = false
    let ws: WebSocket | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let staleTimer: ReturnType<typeof setTimeout> | undefined
    const unavailable = () => {
      if (!cancelled)
        setState({ siteId, count: null, locations: [], unavailable: true })
    }
    function armTimeout() {
      clearTimeout(staleTimer)
      staleTimer = setTimeout(() => {
        unavailable()
        ws?.close()
      }, staleAfterMs)
    }
    function connect() {
      if (cancelled) return
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
      ws = new WebSocket(
        `${protocol}//${window.location.host}/api/sites/${siteId}/realtime/ws`
      )
      armTimeout()
      ws.onmessage = (event) => {
        if (cancelled) return
        try {
          const data = payloadSchema.parse(JSON.parse(event.data as string))
          setState({ siteId, ...data, unavailable: false })
          armTimeout()
        } catch {
          /* Invalid frames do not refresh the activity clock. */
        }
      }
      ws.onclose = () => {
        clearTimeout(staleTimer)
        if (!cancelled) {
          unavailable()
          retryTimer = setTimeout(connect, 5000)
        }
      }
      ws.onerror = () => {
        unavailable()
        ws?.close()
      }
    }
    connect()
    return () => {
      cancelled = true
      clearTimeout(retryTimer)
      clearTimeout(staleTimer)
      ws?.close()
    }
  }, [siteId])
  return state.siteId === siteId
    ? state
    : { count: null, locations: [], unavailable: false }
}
