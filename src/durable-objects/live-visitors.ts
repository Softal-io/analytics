import { DurableObject } from "cloudflare:workers"
import type {
  RealtimeVisitorLocation,
  RealtimeVisitorsPayload,
} from "@/lib/realtime"
import {
  REALTIME_SESSION_HEADER,
  authorizedRealtimeSessions,
} from "@/lib/realtime-access"

/**
 * LiveVisitors — one Durable Object per site (§11 of the spec).
 *
 * Caches active visitors in memory and saves their five-minute presence
 * in SQLite so it survives eviction and WebSocket hibernation.
 * The `/collect` Worker pings this object on
 * every pageview (in addition to, not instead of, the D1 write). The
 * dashboard opens a WebSocket (via the Hibernation API, so the object
 * incurs no duration charges while idle) and gets the live count pushed
 * whenever it changes, plus a rebroadcast every minute from the alarm
 * that sweeps stale (>5 min) visitors.
 */

const STALE_AFTER_MS = 5 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 1000

type StoredVisitor = {
  visitor_id: string
  seen_at: number
  latitude: number | null
  longitude: number | null
}

export class LiveVisitors extends DurableObject<Env> {
  private lastSeen = new Map<
    string,
    {
      seenAt: number
      location: Omit<RealtimeVisitorLocation, "count"> | null
    }
  >()

  constructor(ctx: DurableObjectState, bindings: Env) {
    super(ctx, bindings)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS live_visitors (
        visitor_id TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL,
        latitude REAL,
        longitude REAL
      )
    `)
    const cutoff = Date.now() - STALE_AFTER_MS
    this.ctx.storage.sql.exec(
      "DELETE FROM live_visitors WHERE seen_at < ?",
      cutoff
    )
    const stored = this.ctx.storage.sql.exec<StoredVisitor>(
      "SELECT visitor_id, seen_at, latitude, longitude FROM live_visitors"
    )
    for (const visitor of stored) {
      this.lastSeen.set(visitor.visitor_id, {
        seenAt: visitor.seen_at,
        location:
          visitor.latitude !== null && visitor.longitude !== null
            ? { latitude: visitor.latitude, longitude: visitor.longitude }
            : null,
      })
    }
  }

  /** Called by `/collect` on every pageview for this site. */
  async ping(
    visitorId: string,
    location?: Omit<RealtimeVisitorLocation, "count">,
    seenAt = Date.now()
  ): Promise<number> {
    const before = this.lastSeen.size
    const expired = this.sweepExpiredVisitors()
    const previous = this.lastSeen.get(visitorId)
    seenAt = Math.min(Date.now(), seenAt)
    // Retries of old reports must not make an inactive visitor look active now.
    if (
      seenAt < Date.now() - STALE_AFTER_MS ||
      (previous && seenAt < previous.seenAt)
    ) {
      if (expired) await this.broadcast()
      return this.lastSeen.size
    }
    const nextLocation = location ?? null
    this.lastSeen.set(visitorId, {
      seenAt,
      location: nextLocation,
    })
    this.ctx.storage.sql.exec(
      `INSERT INTO live_visitors (visitor_id, seen_at, latitude, longitude)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (visitor_id) DO UPDATE SET
         seen_at = excluded.seen_at,
         latitude = excluded.latitude,
         longitude = excluded.longitude`,
      visitorId,
      this.lastSeen.get(visitorId)?.seenAt ?? Date.now(),
      nextLocation?.latitude ?? null,
      nextLocation?.longitude ?? null
    )

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS)
    }

    if (
      expired ||
      this.lastSeen.size !== before ||
      previous?.location?.latitude !== nextLocation?.latitude ||
      previous?.location?.longitude !== nextLocation?.longitude
    ) {
      await this.broadcast()
    }
    return this.lastSeen.size
  }

  /**
   * Current live count, for callers that can't hold a WebSocket open.
   *
   * The miniapp dashboard polls this via `GET /ext/v1/sites/:id/realtime`
   * because the host-mediated HTTP transport is request/response only —
   * there's no WebSocket upgrade available to it. Read-only: it sweeps
   * stale visitors like the alarm does but never schedules one, so
   * polling an idle site can't keep the object awake.
   */
  async count(): Promise<number> {
    if (this.sweepExpiredVisitors()) await this.broadcast()
    return this.lastSeen.size
  }

  /** Live count and grouped approximate locations for public dashboard polling. */
  async snapshot(): Promise<RealtimeVisitorsPayload> {
    if (this.sweepExpiredVisitors()) await this.broadcast()
    return this.payload()
  }

  /** WebSocket upgrade — proxied here from `/api/sites/:id/realtime/ws`. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 })
    }

    const sessionId = request.headers.get(REALTIME_SESSION_HEADER)
    if (
      !sessionId ||
      !(await authorizedRealtimeSessions([sessionId])).has(sessionId)
    )
      return new Response("Sign in required", { status: 401 })

    if (this.sweepExpiredVisitors()) await this.broadcast()
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    pair[1].serializeAttachment({ sessionId })
    pair[1].send(JSON.stringify(this.payload()))
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS)

    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(): Promise<void> {
    // The dashboard doesn't send anything meaningful over the socket —
    // it's push-only. Nothing to do here.
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close()
    } catch {
      // already closed
    }
  }

  async webSocketError(): Promise<void> {
    // Hibernation API will clean up the socket; nothing else to do.
  }

  /** Fires once a minute (§11) while there's anything to track. */
  async alarm(): Promise<void> {
    this.sweepExpiredVisitors()
    // Also refresh hibernated sockets when the constructor already pruned expired rows.
    await this.broadcast()

    if (this.lastSeen.size > 0 || this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS)
    }
  }

  private sweepExpiredVisitors(): boolean {
    const before = this.lastSeen.size
    const cutoff = Date.now() - STALE_AFTER_MS
    for (const [visitorId, visitor] of this.lastSeen) {
      if (visitor.seenAt < cutoff) {
        this.lastSeen.delete(visitorId)
        this.ctx.storage.sql.exec(
          "DELETE FROM live_visitors WHERE visitor_id = ?",
          visitorId
        )
      }
    }
    return this.lastSeen.size !== before
  }

  private async broadcast(): Promise<void> {
    const sockets = this.ctx.getWebSockets().map((ws) => {
      let sessionId: string | null = null
      try {
        const attachment: unknown = ws.deserializeAttachment()
        if (
          attachment &&
          typeof attachment === "object" &&
          "sessionId" in attachment &&
          typeof attachment.sessionId === "string"
        )
          sessionId = attachment.sessionId
      } catch {
        // Old connections have no attachment and must reconnect with a verified session.
      }
      return { ws, sessionId }
    })
    let authorized: Set<string>
    try {
      authorized = await authorizedRealtimeSessions(
        sockets.flatMap(({ sessionId }) => (sessionId ? [sessionId] : []))
      )
    } catch {
      for (const { ws } of sockets)
        this.closeSocket(ws, 1011, "Access check unavailable")
      return
    }
    const payload = JSON.stringify(this.payload())
    for (const { ws, sessionId } of sockets) {
      if (!sessionId || !authorized.has(sessionId)) {
        this.closeSocket(ws, 1008, "Sign in required")
        continue
      }
      try {
        ws.send(payload)
      } catch {
        // socket may have closed between getWebSockets() and send()
      }
    }
  }

  private closeSocket(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason)
    } catch {
      /* Already closed. */
    }
  }

  private payload(): RealtimeVisitorsPayload {
    const locations = new Map<string, RealtimeVisitorLocation>()

    for (const visitor of this.lastSeen.values()) {
      if (!visitor.location) continue
      const { latitude, longitude } = visitor.location
      const key = `${latitude}:${longitude}`
      const existing = locations.get(key)
      if (existing) {
        existing.count += 1
      } else {
        locations.set(key, { latitude, longitude, count: 1 })
      }
    }

    return {
      count: this.lastSeen.size,
      locations: Array.from(locations.values()).sort(
        (a, b) => b.count - a.count
      ),
    }
  }
}
