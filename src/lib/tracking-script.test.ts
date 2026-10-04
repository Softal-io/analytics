import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { webcrypto } from "node:crypto"
import { describe, expect, it } from "vitest"

const script = readFileSync(
  new URL("../../public/script.js", import.meta.url),
  "utf8"
)
function browserFixture(
  options: {
    hidden?: boolean
    unfocused?: boolean
    hashRouting?: boolean
    url?: string
    referrer?: string
    urlLimit?: number
    pathLimit?: number
    initialDelayMs?: number
  } = {}
) {
  let now = 0
  let clockOffset = 0
  const epoch = Date.parse("2026-09-01T12:00:00Z")
  let focused = !options.unfocused
  let nextStatus = 204
  let hang = false
  const payloads: Array<Record<string, unknown>> = []
  const beacons: Array<Record<string, unknown>> = []
  const windowListeners = new Map<string, () => void>()
  const documentListeners = new Map<string, (event?: unknown) => void>()
  const timers = new Map<number, { at: number; fn: () => void }>()
  let timerId = 0
  let heartbeat = () => {}
  const document = {
    currentScript: {
      src: "https://analytics.example/script.js",
      getAttribute: (name: string) =>
        name === "data-site"
          ? "site"
          : name === "data-hash-routing" && options.hashRouting
            ? "true"
            : name === "data-url-limit" && options.urlLimit
              ? String(options.urlLimit)
              : name === "data-path-limit" && options.pathLimit
                ? String(options.pathLimit)
                : null,
    },
    referrer: options.referrer ?? "",
    title: "Fixture",
    readyState: "complete",
    visibilityState: options.hidden ? "hidden" : "visible",
    hasFocus: () => focused,
    addEventListener: (name: string, fn: (event?: unknown) => void) =>
      documentListeners.set(name, fn),
  }
  const window = {
    addEventListener: (name: string, fn: () => void) =>
      windowListeners.set(name, fn),
    wa: { track: (_name: string, _props?: unknown) => {} },
  }
  const initialUrl = new URL(options.url ?? "https://fixture.example/")
  const location = {
    href: options.url ?? "https://fixture.example/",
    hostname: "fixture.example",
    pathname: initialUrl.pathname,
    search: initialUrl.search,
    hash: initialUrl.hash,
  }
  const history = {
    pushState: (_data: unknown, _unused: unknown, path: string) => {
      location.pathname = path
    },
    replaceState: (_data: unknown, _unused: unknown, path: string) => {
      location.pathname = path
    },
  }
  runInNewContext(script, {
    document,
    window,
    location,
    history,
    URL,
    URLSearchParams,
    Uint8Array,
    crypto: webcrypto,
    AbortController,
    performance: { now: () => now },
    Date: { now: () => epoch + now + clockOffset },
    Blob,
    setInterval: (fn: () => void) => {
      heartbeat = fn
    },
    setTimeout: (fn: () => void, delay: number) => {
      const id = ++timerId
      timers.set(id, { at: now + delay, fn })
      return id
    },
    clearTimeout: (id: number) => timers.delete(id),
    navigator: {
      sendBeacon: (_endpoint: string, blob: Blob) => {
        void blob.text().then((body) => beacons.push(JSON.parse(body)))
        return true
      },
    },
    fetch: (
      _endpoint: string,
      init: { body: string; credentials: string; signal: AbortSignal }
    ) => {
      expect(init.credentials).toBe("omit")
      payloads.push(JSON.parse(init.body))
      if (payloads.length === 1 && options.initialDelayMs)
        return new Promise((resolve) => {
          timers.set(++timerId, {
            at: now + options.initialDelayMs!,
            fn: () => resolve({ status: 204 }),
          })
        })
      if (hang)
        return new Promise((_resolve, reject) =>
          init.signal.addEventListener("abort", () =>
            reject(new Error("Aborted"))
          )
        )
      const status = nextStatus
      nextStatus = 204
      return Promise.resolve({ status })
    },
  })
  return {
    payloads,
    beacons,
    location,
    changeClock: (offset: number) => {
      clockOffset = offset
    },
    history,
    window,
    settle: () => new Promise<void>((resolve) => setImmediate(resolve)),
    advance: (ms: number) => {
      now += ms
      for (const [id, timer] of timers)
        if (timer.at <= now) {
          timers.delete(id)
          timer.fn()
        }
    },
    heartbeat: () => heartbeat(),
    failNext: () => {
      nextStatus = 503
    },
    hangNext: () => {
      hang = true
    },
    restoreNetwork: () => {
      hang = false
      windowListeners.get("online")!()
    },
    hide: () => {
      document.visibilityState = "hidden"
      documentListeners.get("visibilitychange")!()
    },
    show: () => {
      document.visibilityState = "visible"
      documentListeners.get("visibilitychange")!()
    },
    blur: () => {
      focused = false
      windowListeners.get("blur")!()
    },
    focus: () => {
      focused = true
      windowListeners.get("focus")!()
    },
    pagehide: () => windowListeners.get("pagehide")!(),
    pageshow: () => windowListeners.get("pageshow")!(),
    setHash: (hash: string) => {
      location.hash = hash
      windowListeners.get("hashchange")?.()
    },
    middleClick: (href: string, button = 1) =>
      documentListeners.get("auxclick")!({
        button,
        target: { closest: () => ({ href }) },
      }),
    click: (href: string) =>
      documentListeners.get("click")!({
        target: { closest: () => ({ href }) },
      }),
  }
}

describe("visible-page tracking", () => {
  it("keeps page-start times fixed through a delayed initial POST, retries, and clock changes", async () => {
    const page = browserFixture({ initialDelayMs: 5000 })
    const epoch = Date.parse("2026-09-01T12:00:00Z")
    expect(page.payloads[0].page_started_at_ms).toBe(epoch)
    page.advance(1000)
    page.changeClock(3600000)
    page.history.pushState({}, "", "/pricing")
    expect(page.payloads).toHaveLength(1)
    page.advance(4000)
    await page.settle()
    expect(page.payloads[1]).toMatchObject({
      kind: "time",
      page_started_at_ms: epoch,
      elapsed_ms: 5000,
      duration_ms: 1000,
    })
    expect(page.payloads[2]).toMatchObject({
      kind: "page",
      path: "/pricing",
      page_started_at_ms: epoch + 1000,
      elapsed_ms: 4000,
    })
    page.failNext()
    page.window.wa.track("signup")
    await page.settle()
    const failed = page.payloads.at(-1)!
    page.advance(15000)
    page.heartbeat()
    await page.settle()
    const retry = [...page.payloads]
      .reverse()
      .find((item) => item.event_id === failed.event_id)!
    expect(retry).toMatchObject({
      page_started_at_ms: epoch + 1000,
      elapsed_ms: 19000,
    })
    expect(retry.event_id).toBe(failed.event_id)
    page.advance(1000)
    page.pagehide()
    await page.settle()
    expect(page.beacons.at(-1)).toMatchObject({
      kind: "time",
      page_started_at_ms: epoch + 1000,
      elapsed_ms: 20000,
    })
  })
  it("measures single-page reading, pauses unfocused time, and flushes on exit", async () => {
    const page = browserFixture()
    await page.settle()
    const id = page.payloads[0].page_id
    page.advance(8000)
    page.blur()
    await page.settle()
    expect(page.payloads.at(-1)).toMatchObject({
      kind: "time",
      page_id: id,
      duration_ms: 8000,
    })
    const count = page.payloads.length
    page.advance(60000)
    page.heartbeat()
    page.hide()
    page.show()
    await page.settle()
    expect(page.payloads).toHaveLength(count)
    page.focus()
    page.advance(15000)
    page.heartbeat()
    await page.settle()
    expect(page.payloads.at(-1)).toMatchObject({
      page_id: id,
      duration_ms: 23000,
    })
    page.advance(4000)
    page.pagehide()
    await page.settle()
    expect(page.payloads.at(-1)).toMatchObject({
      page_id: id,
      duration_ms: 27000,
    })
    expect(
      page.payloads.filter((payload) => payload.kind === "page")
    ).toHaveLength(1)
  })
  it("keeps SPA times separate and preserves the full outbound destination", async () => {
    const page = browserFixture()
    await page.settle()
    const first = page.payloads[0].page_id
    page.advance(12000)
    page.history.pushState({}, "", "/offer")
    await page.settle()
    expect(page.payloads[1]).toMatchObject({
      page_id: first,
      duration_ms: 12000,
    })
    const second = page.payloads[2].page_id
    expect(second).not.toBe(first)
    expect(page.payloads[2]).toMatchObject({
      previous_page_id: first,
      path: "/offer",
    })
    page.advance(5000)
    page.click("https://vendor.example/product?id=42&aff=partner#buy")
    await page.settle()
    expect(page.payloads.at(-1)).toMatchObject({
      kind: "outbound",
      page_id: second,
      path: "/offer",
      duration_ms: 5000,
      outbound_url: "https://vendor.example/product?id=42&aff=partner#buy",
    })
    page.window.wa.track("signup", { plan: "pro" })
    await page.settle()
    expect(page.payloads.at(-1)).toMatchObject({
      page_id: second,
      name: "signup",
      duration_ms: 5000,
      path: "/offer",
    })
    page.click("https://fixture.example/internal")
    await page.settle()
    expect(page.payloads.at(-1)?.name).toBe("signup")
  })
  it("resumes restored pages without counting background time or another pageview", async () => {
    const page = browserFixture()
    await page.settle()
    page.advance(3000)
    page.pagehide()
    await page.settle()
    page.advance(60000)
    page.pageshow()
    page.advance(2000)
    page.heartbeat()
    await page.settle()
    expect(page.payloads.at(-1)?.duration_ms).toBe(5000)
    expect(
      page.payloads.filter((payload) => payload.kind === "page")
    ).toHaveLength(1)
  })
  it("starts a fresh segment after 30 minutes, including initially hidden or unfocused pages", async () => {
    for (const options of [{}, { hidden: true }, { unfocused: true }]) {
      const page = browserFixture(options)
      await page.settle()
      const first = page.payloads[0].page_id
      page.advance(5000)
      page.blur()
      await page.settle()
      page.advance(31 * 60 * 1000)
      page.show()
      page.focus()
      await page.settle()
      expect(
        page.payloads.filter((payload) => payload.kind === "page")
      ).toHaveLength(2)
      expect(page.payloads.at(-1)?.page_id).not.toBe(first)
      page.advance(3000)
      page.pagehide()
      await page.settle()
      expect(page.payloads.at(-1)?.duration_ms).toBe(3000)
    }
  })
  it("does not duplicate a hidden SPA route when focus returns", async () => {
    const page = browserFixture()
    await page.settle()
    page.hide()
    page.advance(31 * 60 * 1000)
    page.history.pushState({}, "", "/background-route")
    await page.settle()
    page.advance(1000)
    page.show()
    await page.settle()
    expect(
      page.payloads.filter((payload) => payload.kind === "page")
    ).toHaveLength(2)
  })
  it("retries lost final time while hidden, even when a beacon was accepted", async () => {
    const page = browserFixture()
    await page.settle()
    page.advance(12000)
    page.failNext()
    page.hide()
    await page.settle()
    const first = page.payloads.at(-1)!
    expect(first.duration_ms).toBe(12000)
    expect(page.beacons.some((payload) => payload.duration_ms === 12000)).toBe(
      true
    )
    page.advance(15000)
    page.heartbeat()
    await page.settle()
    expect(page.payloads.at(-1)).toMatchObject({
      page_id: first.page_id,
      page_key: first.page_key,
      duration_ms: 12000,
      activity_ms: 12000,
      elapsed_ms: 27000,
    })
    const count = page.payloads.length
    page.advance(15000)
    page.heartbeat()
    await page.settle()
    expect(page.payloads).toHaveLength(count)
  })
  it("retries actions with the same ID and times out stuck requests", async () => {
    const page = browserFixture()
    await page.settle()
    page.advance(5000)
    page.hangNext()
    page.window.wa.track("signup")
    await page.settle()
    const first = page.payloads.at(-1)!
    page.advance(10000)
    await page.settle()
    page.restoreNetwork()
    await page.settle()
    expect(page.payloads.at(-1)).toMatchObject({
      event_id: first.event_id,
      name: "signup",
      activity_ms: 5000,
      elapsed_ms: 15000,
    })
  })
  it("never throws when custom event props contain circular values", async () => {
    const page = browserFixture()
    await page.settle()
    const props: { self?: unknown } = {}
    props.self = props
    expect(() => page.window.wa.track("bad", props)).not.toThrow()
    await page.settle()
    expect(page.payloads).toHaveLength(1)
  })
})

describe("navigation and link coverage", () => {
  it("bounds long paths while tracking navigation between different overflow pages", async () => {
    const first = "/download/" + "x".repeat(2100)
    const second = "/download/" + "y".repeat(2100)
    const page = browserFixture({ url: `https://fixture.example${first}` })
    await page.settle()
    expect(page.payloads[0].path).toBe("Page path exceeds recording limit")
    expect(page.payloads[0].page_url).toBeUndefined()
    page.history.replaceState(null, "", first)
    await page.settle()
    expect(page.payloads).toHaveLength(1)
    page.advance(15000)
    page.history.pushState(null, "", second)
    await page.settle()
    expect(page.payloads.filter((item) => item.kind === "page")).toHaveLength(2)
    expect(
      page.payloads.find((item) => item.kind === "time")?.duration_ms
    ).toBe(15000)
    page.click("https://vendor.example/offer")
    await page.settle()
    expect(page.payloads.at(-1)?.kind).toBe("outbound")
    const configured = browserFixture({
      url: "https://fixture.example/longer-path",
      pathLimit: 10,
    })
    await configured.settle()
    expect(configured.payloads[0].path).toBe(
      "Page path exceeds recording limit"
    )
  })
  it("bounds URL details without losing page time or outbound actions", async () => {
    const page = browserFixture({
      url: `https://fixture.example/?token=${"x".repeat(9000)}`,
      referrer: `https://presentifyapp.com/offers?token=${"x".repeat(9000)}`,
    })
    await page.settle()
    expect(page.payloads[0].page_url).toBeUndefined()
    expect(page.payloads[0].referrer).toBe("presentifyapp.com")
    expect(JSON.stringify(page.payloads[0]).length).toBeLessThan(1500)
    page.advance(15000)
    page.click(`https://vendor.example/?token=${"x".repeat(9000)}`)
    await page.settle()
    expect(page.payloads.at(-1)).toMatchObject({
      kind: "outbound",
      outbound_url: "(url-too-long)",
      duration_ms: 15000,
    })
  })
  it("preserves the entire URL at the configured character boundary", async () => {
    const prefix = "https://fixture.example/?value="
    const boundary = prefix + "x".repeat(500 - prefix.length)
    const page = browserFixture({ url: boundary })
    await page.settle()
    expect(page.payloads[0].page_url).toBe(boundary)
    const oversized = browserFixture({ url: boundary + "x" })
    await oversized.settle()
    expect(oversized.payloads[0].page_url).toBeUndefined()
    const configured = browserFixture({ url: boundary + "x", urlLimit: 600 })
    await configured.settle()
    expect(configured.payloads[0].page_url).toBe(boundary + "x")
  })
  it("tracks a middle click exactly once and ignores other auxiliary buttons", async () => {
    const page = browserFixture()
    await page.settle()
    page.middleClick("https://vendor.example/offer?aff=Presentify#buy")
    await page.settle()
    page.middleClick("https://vendor.example/offer", 2)
    await page.settle()
    expect(
      page.payloads.filter((item) => item.kind === "outbound")
    ).toHaveLength(1)
    expect(page.payloads.at(-1)?.outbound_url).toBe(
      "https://vendor.example/offer?aff=Presentify#buy"
    )
  })
  it("supports opt-in hash routes while leaving ordinary section anchors alone", async () => {
    const plain = browserFixture()
    await plain.settle()
    plain.setHash("#features")
    await plain.settle()
    expect(plain.payloads.filter((item) => item.kind === "page")).toHaveLength(
      1
    )
    const routed = browserFixture({ hashRouting: true })
    await routed.settle()
    routed.setHash("#/pricing")
    await routed.settle()
    expect(routed.payloads.at(-1)?.path).toBe("/#/pricing")
    expect(routed.payloads[0].context_key).toBe(
      routed.payloads.at(-1)?.context_key
    )
    expect(routed.payloads[0].page_id).not.toBe(routed.payloads.at(-1)?.page_id)
  })
})
