/**
 * Personal Web Analytics. Use data-site on this script; custom events use
 * window.wa.track("signup", { plan: "pro" }). Page credentials and pending
 * reports live only in memory. No cookies or browser storage are used.
 */
;(function () {
  "use strict"
  var script = document.currentScript
  if (!script) return
  var siteId = script.getAttribute("data-site")
  if (!siteId) return
  var endpoint = new URL("/collect", script.src).toString()
  var page = null
  var pending = []
  var inFlight = false
  var retryAt = 0
  var failures = 0
  var SESSION_MS = 30 * 60 * 1000
  var DAY_MS = 86400000
  // Keep page timestamps on one timeline, even if the device clock changes.
  var clockOrigin = Date.now() - performance.now()
  var contextKey = uuid()
  var hashRouting = script.getAttribute("data-hash-routing") === "true"
  var urlLimit = Number(script.getAttribute("data-url-limit")) || 500
  var pathLimit = Number(script.getAttribute("data-path-limit")) || 2048

  function recordedUrl(value) {
    return value && value.length <= urlLimit ? value : undefined
  }

  function uuid() {
    return "10000000-1000-4000-8000-100000000000".replace(
      /[018]/g,
      function (c) {
        return (
          Number(c) ^
          (crypto.getRandomValues(new Uint8Array(1))[0] &
            (15 >> (Number(c) / 4)))
        ).toString(16)
      }
    )
  }
  function visible() {
    return document.visibilityState === "visible" && document.hasFocus()
  }
  function accumulate() {
    if (!page) return 0
    if (page.activeSince !== null) {
      var now = performance.now()
      page.activeMs += Math.max(0, now - page.activeSince)
      page.activeSince = now
      page.activity = now
    }
    return Math.min(DAY_MS, Math.floor(page.activeMs))
  }
  function payload(item) {
    var data = Object.assign({}, item.page.data, item.action)
    data.duration_ms = item.duration
    data.elapsed_ms = Math.min(
      2 * DAY_MS,
      Math.floor(Math.max(0, performance.now() - item.page.born))
    )
    data.activity_ms = Math.min(
      data.elapsed_ms,
      Math.floor(Math.max(0, item.activity - item.page.born))
    )
    return JSON.stringify(data)
  }
  function enqueue(kind, action) {
    if (!page) return
    try {
      // Snapshot props so later host-page mutations and circular values cannot affect retries.
      action = JSON.parse(JSON.stringify(action || {}))
      action.kind = kind
      var duration = accumulate()
      var existing =
        kind === "time"
          ? pending.find(function (item) {
              return item.page === page && item.action.kind === "time"
            })
          : null
      if (existing) {
        existing.duration = duration
        existing.activity = page.activity
        existing.revision++
      } else {
        if (pending.length >= 100) pending.shift()
        pending.push({
          page: page,
          action: action,
          duration: duration,
          activity: page.activity,
          revision: 0,
        })
      }
      pump()
    } catch (_error) {
      /* Invalid custom props must never affect the host website. */
    }
  }
  function pump() {
    if (inFlight || performance.now() < retryAt) return
    // Bounded, memory-only retries. There is no reliable delivery after a page is destroyed.
    while (
      pending.length &&
      performance.now() - pending[0].page.born >= 2 * DAY_MS
    )
      pending.shift()
    if (!pending.length) return
    var item = pending[0]
    var revision = item.revision
    var body
    try {
      body = payload(item)
    } catch (_error) {
      pending.shift()
      pump()
      return
    }
    inFlight = true
    var controller = new AbortController()
    var timeout = setTimeout(function () {
      controller.abort()
    }, 10000)
    fetch(endpoint, {
      method: "POST",
      body: body,
      keepalive: true,
      credentials: "omit",
      signal: controller.signal,
      headers: { "Content-Type": "text/plain" },
    })
      .then(function (response) {
        clearTimeout(timeout)
        inFlight = false
        if (
          response.status === 204 ||
          (response.status >= 400 &&
            response.status < 500 &&
            response.status !== 429)
        ) {
          // A newer cumulative total may have replaced this item during the request.
          if (item.revision === revision) {
            var index = pending.indexOf(item)
            if (index >= 0) pending.splice(index, 1)
          }
          failures = 0
          retryAt = 0
          pump()
        } else failed()
      })
      .catch(function () {
        clearTimeout(timeout)
        inFlight = false
        failed()
      })
  }
  function failed() {
    failures++
    retryAt =
      performance.now() +
      Math.min(60000, 1000 * Math.pow(2, Math.min(failures, 6)))
  }
  function beaconPending() {
    if (!navigator.sendBeacon) return
    // Limit unload work to the browser's keepalive budget. Beacon acceptance is
    // not a persistence acknowledgement; retain these items for a live-page retry.
    var bytes = 0
    for (var i = 0; i < pending.length; i++) {
      try {
        var body = payload(pending[i])
        var blob = new Blob([body], { type: "text/plain" })
        bytes += blob.size
        if (bytes > 48 * 1024) break
        navigator.sendBeacon(endpoint, blob)
      } catch (_error) {
        /* Best effort while the browser is leaving. */
      }
    }
  }
  function flushTime() {
    if (!page) return
    var duration = accumulate()
    if (duration > page.queuedMs) {
      page.queuedMs = duration
      enqueue("time")
    }
    pump() // Retry even while hidden and cumulative time has not changed.
  }
  function pause() {
    if (!page) return
    flushTime()
    if (page.activeSince !== null) page.pausedAt = performance.now()
    page.activeSince = null
    beaconPending()
  }
  function resume() {
    if (!page || !visible() || page.activeSince !== null) return
    var now = performance.now()
    if (now - page.pausedAt >= SESSION_MS || now - page.born >= DAY_MS) {
      trackPage(true)
      return
    }
    page.activeSince = now
    page.activity = now
    pump()
  }
  function referrer() {
    if (!document.referrer) return null
    try {
      var url = new URL(document.referrer)
      return url.protocol === "https:" || url.protocol === "http:"
        ? recordedUrl(url.href) || url.hostname
        : undefined
    } catch (_error) {
      return undefined
    }
  }
  function trackPage(force) {
    var path =
      (location.pathname || "/") + (hashRouting ? location.hash || "" : "")
    if (page && page.path === path && force !== true) return
    flushTime()
    var previous = page
    var now = performance.now()
    var data = {
      version: 2,
      context_key: contextKey,
      page_url: recordedUrl(location.href),
      site_id: siteId,
      page_id: uuid(),
      page_key: uuid(),
      page_started_at_ms: Math.floor(clockOrigin + now),
      path:
        path.length <= pathLimit ? path : "Page path exceeds recording limit",
      title: document.title.slice(0, 500),
      referrer: referrer(),
    }
    if (previous) {
      data.previous_page_id = previous.data.page_id
      data.previous_page_key = previous.data.page_key
    }
    var search = new URLSearchParams(location.search)
    ;["utm_source", "utm_medium", "utm_campaign"].forEach(function (key) {
      var value = search.get(key)
      if (value) data[key] = value.slice(0, key === "utm_campaign" ? 500 : 200)
    })
    // Reset the inactivity clock on every route, including hidden SPA navigation.
    page = {
      path: path,
      data: data,
      born: now,
      activity: now,
      activeMs: 0,
      activeSince: visible() ? now : null,
      pausedAt: now,
      queuedMs: 0,
    }
    enqueue("page")
  }
  function action(kind, values) {
    if (!page) trackPage()
    // An explicit action after a long idle period starts a fresh visit too.
    if (
      page.activeSince === null &&
      performance.now() - page.pausedAt >= SESSION_MS
    )
      trackPage(true)
    page.activity = performance.now()
    values.event_id = uuid()
    enqueue(kind, values)
  }
  function outbound(event) {
    var anchor =
      event.target && event.target.closest
        ? event.target.closest("a[href]")
        : null
    if (!anchor) return
    try {
      var url = new URL(anchor.href, location.href)
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.hostname.replace(/^www\./, "") !==
          location.hostname.replace(/^www\./, "")
      ) {
        action("outbound", {
          outbound_url: recordedUrl(url.href) || "(url-too-long)",
        })
        beaconPending()
      }
    } catch (_error) {}
  }
  var originalPush = history.pushState
  var originalReplace = history.replaceState
  history.pushState = function () {
    originalPush.apply(this, arguments)
    trackPage()
  }
  history.replaceState = function () {
    originalReplace.apply(this, arguments)
    trackPage()
  }
  window.addEventListener("popstate", trackPage)
  document.addEventListener("click", outbound, true)
  document.addEventListener(
    "auxclick",
    function (event) {
      if (event.button === 1) outbound(event)
    },
    true
  )
  if (hashRouting) window.addEventListener("hashchange", trackPage)
  setInterval(function () {
    if (page && visible() && performance.now() - page.born >= DAY_MS)
      trackPage(true)
    else flushTime()
  }, 15000)
  document.addEventListener("visibilitychange", function () {
    if (visible()) resume()
    else pause()
  })
  window.addEventListener("blur", pause)
  window.addEventListener("focus", resume)
  window.addEventListener("pagehide", pause)
  window.addEventListener("pageshow", resume)
  window.addEventListener("online", function () {
    retryAt = 0
    pump()
  })
  window.wa = {
    track: function (name, props) {
      if (name)
        action("event", {
          name: String(name).slice(0, 200),
          props: props || undefined,
        })
    },
  }
  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  )
    trackPage()
  else document.addEventListener("DOMContentLoaded", trackPage)
})()
