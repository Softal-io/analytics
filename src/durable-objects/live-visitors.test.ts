import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LiveVisitors } from "./live-visitors"

const access = vi.hoisted(() => ({ valid: new Set<string>(), fail: false }))
vi.mock("@/lib/realtime-access", () => ({
  REALTIME_SESSION_HEADER: "X-Analytics-Session-ID",
  authorizedRealtimeSessions: (ids: Array<string>) =>
    access.fail
      ? Promise.reject(new Error("Database unavailable"))
      : Promise.resolve(new Set(ids.filter((id) => access.valid.has(id)))),
}))

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(public ctx: DurableObjectState) {}
  },
}))

type TestSocket = Pick<WebSocket, "send"> &
  Partial<Pick<WebSocket, "close" | "deserializeAttachment">>
function createState(sockets: Array<TestSocket> = []) {
  for (const socket of sockets) {
    socket.deserializeAttachment ??= () => ({ sessionId: "session" })
    socket.close ??= vi.fn()
  }
  const database = new DatabaseSync(":memory:")
  let alarm: number | null = null
  const state = {
    storage: {
      sql: {
        exec(query: string, ...values: Array<string | number | null>) {
          const statement = database.prepare(query)
          if (query.trim().startsWith("SELECT")) return statement.all(...values)
          statement.run(...values)
          return []
        },
      },
      getAlarm: () => Promise.resolve(alarm),
      setAlarm: (value: number) => {
        alarm = value
        return Promise.resolve()
      },
    },
    getWebSockets: () => sockets,
  } as unknown as DurableObjectState
  return { state, database }
}

describe("live visitor persistence", () => {
  it("returns grouped live locations and expires them in polling snapshots", async () => {
    vi.useFakeTimers()
    const { state, database } = createState()
    const visitors = new LiveVisitors(state, {} as Env)
    await visitors.ping("one", { latitude: 53.3, longitude: -6.2 })
    await visitors.ping("two", { latitude: 53.3, longitude: -6.2 })
    await visitors.ping("unknown")
    expect(await visitors.snapshot()).toEqual({
      count: 3,
      locations: [{ latitude: 53.3, longitude: -6.2, count: 2 }],
    })
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(await visitors.snapshot()).toEqual({ count: 0, locations: [] })
    database.close()
  })
  it("does not revive stale visitors or move their presence backward when reports retry", async () => {
    vi.useFakeTimers()
    const { state, database } = createState()
    const visitors = new LiveVisitors(state, {} as Env)
    const originalTime = Date.now()
    await visitors.ping("one", { latitude: 1, longitude: 2 }, originalTime)
    vi.advanceTimersByTime(60000)
    await visitors.ping("one", { latitude: 3, longitude: 4 }, Date.now())
    await visitors.ping("one", { latitude: 1, longitude: 2 }, originalTime)
    expect((await visitors.snapshot()).locations).toEqual([
      { latitude: 3, longitude: 4, count: 1 },
    ])
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(await visitors.ping("one", undefined, originalTime)).toBe(0)
    expect(await visitors.snapshot()).toEqual({ count: 0, locations: [] })
    database.close()
  })
  beforeEach(() => {
    access.valid = new Set(["session"])
    access.fail = false
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("restores active visitors after the object is recreated", async () => {
    const { state, database } = createState()
    const first = new LiveVisitors(state, {} as Env)
    await first.ping("visitor", { latitude: 53.3, longitude: -6.2 })
    const restored = new LiveVisitors(state, {} as Env)
    expect(await restored.count()).toBe(1)
    await restored.ping("visitor")
    expect(await restored.count()).toBe(1)
    database.close()
  })

  it("expires presence after five minutes, including across hibernation", async () => {
    vi.useFakeTimers()
    const { state, database } = createState()
    const first = new LiveVisitors(state, {} as Env)
    await first.ping("visitor")
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    const restored = new LiveVisitors(state, {} as Env)
    expect(await restored.count()).toBe(0)
    expect(
      database.prepare("SELECT count(*) AS count FROM live_visitors").get()
        ?.count
    ).toBe(0)
    database.close()
  })

  it("broadcasts expiration when a remaining visitor pings without moving", async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const { state, database } = createState([{ send }])
    const visitors = new LiveVisitors(state, {} as Env)
    await visitors.ping("expired", { latitude: 1, longitude: 2 })
    vi.advanceTimersByTime(60 * 1000)
    await visitors.ping("active", { latitude: 3, longitude: 4 })
    send.mockClear()
    vi.advanceTimersByTime(4 * 60 * 1000 + 1)

    expect(await visitors.ping("active", { latitude: 3, longitude: 4 })).toBe(1)
    expect(send).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        count: 1,
        locations: [{ latitude: 3, longitude: 4, count: 1 }],
      })
    )
    database.close()
  })

  it("broadcasts location changes when a new visitor replaces an expired one", async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const { state, database } = createState([{ send }])
    const visitors = new LiveVisitors(state, {} as Env)
    await visitors.ping("expired", { latitude: 1, longitude: 2 })
    send.mockClear()
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)

    expect(await visitors.ping("new")).toBe(1)
    expect(send).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ count: 1, locations: [] })
    )
    database.close()
  })

  it("notifies connected dashboards when a count read expires visitors", async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const { state, database } = createState([{ send }])
    const visitors = new LiveVisitors(state, {} as Env)
    await visitors.ping("expired")
    send.mockClear()
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)

    expect(await visitors.count()).toBe(0)
    expect(send).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ count: 0, locations: [] })
    )
    database.close()
  })

  it("refreshes hibernated sockets when visitors expired before alarm wakeup", async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const { state, database } = createState([{ send }])
    await new LiveVisitors(state, {} as Env).ping("expired")
    send.mockClear()
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)

    await new LiveVisitors(state, {} as Env).alarm()
    expect(send).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ count: 0, locations: [] })
    )
    database.close()
  })

  it("closes revoked connections without sending new visitor locations", async () => {
    const send = vi.fn(),
      close = vi.fn()
    const { state, database } = createState([{ send, close }])
    const visitors = new LiveVisitors(state, {} as Env)
    await visitors.ping("first")
    send.mockClear()
    access.valid.clear()
    await visitors.ping("new", { latitude: 1, longitude: 2 })
    expect(send).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledWith(1008, "Sign in required")
    database.close()
  })

  it("revalidates connections on alarm wakeup after hibernation", async () => {
    const send = vi.fn(),
      close = vi.fn()
    const { state, database } = createState([{ send, close }])
    await new LiveVisitors(state, {} as Env).ping("visitor")
    send.mockClear()
    access.valid.clear()
    await new LiveVisitors(state, {} as Env).alarm()
    expect(send).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledWith(1008, "Sign in required")
    database.close()
  })

  it("requires legacy connections without session metadata to reconnect", async () => {
    const send = vi.fn(),
      close = vi.fn()
    const { state, database } = createState([
      { send, close, deserializeAttachment: () => null },
    ])
    await new LiveVisitors(state, {} as Env).alarm()
    expect(send).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledWith(1008, "Sign in required")
    database.close()
  })

  it("does not leak private data when the access database is unavailable", async () => {
    const send = vi.fn(),
      close = vi.fn()
    const { state, database } = createState([{ send, close }])
    access.fail = true
    await new LiveVisitors(state, {} as Env).ping("visitor")
    expect(send).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledWith(1011, "Access check unavailable")
    database.close()
  })

  it("rejects handshakes without a verified internal session ID", async () => {
    const { state, database } = createState()
    const visitors = new LiveVisitors(state, {} as Env)
    expect(
      (
        await visitors.fetch(
          new Request("https://analytics.example.com/ws", {
            headers: { Upgrade: "websocket" },
          })
        )
      ).status
    ).toBe(401)
    database.close()
  })
})
