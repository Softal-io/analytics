// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type * as ChartModule from "@cloudflare/kumo/components/chart"
import type { PublicSnapshot } from "@/lib/public-snapshot"
import { PublicDashboard } from "@/components/dashboard/public-dashboard"

vi.mock("@/lib/echarts", () => ({ echarts: {} }))
vi.mock("@/components/dashboard/realtime-globe", () => ({
  RealtimeGlobe: ({
    count,
    locations,
  }: {
    count: number
    locations: Array<unknown>
  }) => (
    <div aria-label="Live globe">
      {count} online, {locations.length} locations
    </div>
  ),
}))
vi.mock("@cloudflare/kumo/components/chart", async (importOriginal) => {
  const original = await importOriginal<typeof ChartModule>()
  return {
    ...original,
    Chart: () => <div aria-label="Traffic chart" />,
  }
})

const list = (label: string) => ({ rows: [{ label, count: 4 }], total: 10 })
function snapshot(overrides: Partial<PublicSnapshot> = {}): PublicSnapshot {
  return {
    site: { name: "Public fixture", domain: "fixture.example" },
    range: { fromDate: "2026-09-01", toDate: "2026-09-30" },
    metrics: {},
    sections: {},
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("public dashboard sharing controls", () => {
  it("keeps mouse hover previews without moving keyboard focus", async () => {
    render(
      <PublicDashboard
        snapshot={snapshot({
          sections: {
            referrers: {
              rows: [
                {
                  label: "presentifyapp.com",
                  count: 4,
                  details: {
                    referrerDomain: "presentifyapp.com",
                    links: [],
                    linkCount: 0,
                  },
                },
              ],
              total: 4,
            },
          },
        })}
      />
    )
    const trigger = screen.getByRole("button", { name: "presentifyapp.com" })
    fireEvent.mouseEnter(trigger)
    fireEvent.mouseMove(trigger)
    await screen.findByRole("dialog", { name: "Source details" })
    expect(document.activeElement).toBe(document.body)
  })
  it("requests URLs only when the source tooltip opens, then updates its navigation link", async () => {
    const referring = "https://presentifyapp.com/offers?placement=footer"
    const details = {
      utmSource: "Presentify",
      utmMedium: "",
      utmCampaign: "",
      links: [],
      linkCount: 0,
    }
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ...details,
          links: [{ url: referring, kind: "referrer", visits: 4 }],
        }),
    })
    vi.stubGlobal("fetch", fetch)
    render(
      <PublicDashboard
        snapshot={snapshot({
          sourceDetailsUrl: "/api/public/lazy-test/source-details?range=7d",
          sections: {
            campaigns: {
              rows: [
                {
                  key: JSON.stringify(["Presentify", "", ""]),
                  label: "Presentify",
                  count: 4,
                  details,
                },
              ],
              total: 4,
            },
          },
        })}
      />
    )
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Presentify" }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(
        screen
          .getByRole("link", { name: "Open Presentify in a new tab" })
          .getAttribute("href")
      ).toBe(referring)
    )
    expect(screen.getByText(referring)).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "Presentify" }))
    fireEvent.click(screen.getByRole("button", { name: "Presentify" }))
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it("reveals complete source tags and recorded URLs, preferring the referring page", async () => {
    const referring = "https://presentifyapp.com/blog/deals?from=footer#offers"
    const landing =
      "https://fixture.example/offers?utm_source=Presentify&utm_campaign=Summer%20Launch"
    const details = {
      utmSource: "Presentify",
      utmMedium: "referral",
      utmCampaign: "Summer Launch",
      links: [
        { url: landing, kind: "landing" as const, visits: 4 },
        { url: referring, kind: "referrer" as const, visits: 3 },
      ],
      linkCount: 2,
    }
    render(
      <PublicDashboard
        snapshot={snapshot({
          sections: {
            campaigns: {
              rows: [{ label: "Summer Launch", count: 4, details }],
              total: 4,
            },
          },
        })}
      />
    )
    expect(screen.getByRole("link").getAttribute("href")).toBe(referring)
    fireEvent.click(screen.getByRole("button", { name: "Summer Launch" }))
    const content = await screen.findByText("Tagged landing URLs")
    const tooltip = within(
      content.closest(".kumo-popover-popup") as HTMLElement
    )
    expect(tooltip.getByText("Presentify")).toBeDefined()
    expect(tooltip.getByText("referral")).toBeDefined()
    expect(
      tooltip.getByRole("link", { name: referring }).getAttribute("href")
    ).toBe(referring)
    expect(
      tooltip.getByRole("link", { name: landing }).getAttribute("href")
    ).toBe(landing)
    const link = tooltip.getByRole("link", { name: landing })
    act(() => link.focus())
    expect(document.activeElement).toBe(link)
    expect(screen.getByRole("dialog", { name: "Source details" })).toBeDefined()
    fireEvent.keyDown(link, { key: "Escape" })
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Source details" })
      ).toBeNull()
    )
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Summer Launch" })
    )
  })
  it("hides the previous live globe when updates are unavailable", () => {
    render(
      <PublicDashboard
        activityUnavailable
        snapshot={snapshot({ realtime: 5, realtimeLocations: [] })}
      />
    )
    expect(screen.queryByLabelText("Live globe")).toBeNull()
    expect(
      screen.getByText("Activity updates unavailable. Reconnecting…")
    ).toBeDefined()
  })
  it("opens actual page, outbound, and referrer URLs in new tabs", () => {
    render(
      <PublicDashboard
        snapshot={snapshot({
          sections: {
            pages: list("/offers"),
            outboundLinks: {
              rows: [
                {
                  label: "vendor.example/Offer",
                  url: "http://vendor.example/Offer",
                  count: 4,
                },
              ],
              total: 4,
            },
            referrers: {
              rows: [
                { label: "google.com", count: 2 },
                { label: "Direct", count: 1 },
                { label: "Unknown", count: 1 },
              ],
              total: 4,
            },
            campaigns: list("newsletter / email"),
          },
        })}
      />
    )
    const links = screen.getAllByRole("link")
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://fixture.example/offers",
      "http://vendor.example/Offer",
      "https://google.com/",
    ])
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank")
      expect(link.getAttribute("rel")).toBe("noopener noreferrer")
      expect(link.getAttribute("aria-label")).toContain("in a new tab")
    }
    const sources = within(screen.getByRole("region", { name: "Sources" }))
    fireEvent.click(sources.getByRole("button", { name: "Campaigns" }))
    expect(sources.queryByRole("link")).toBeNull()
  })
  it("shows the live globe, updates its data, and removes it when sharing is withdrawn", () => {
    const data = snapshot({
      realtime: 2,
      realtimeLocations: [{ latitude: 53.3, longitude: -6.2, count: 2 }],
      sections: { countries: list("Ireland") },
    })
    const { rerender } = render(<PublicDashboard snapshot={data} />)
    expect(
      screen.queryByText("Independent of the selected date range.")
    ).toBeNull()
    expect(
      within(
        screen.getByRole("region", { name: "Locations" })
      ).queryByLabelText("Live globe")
    ).toBeNull()
    expect(
      within(
        screen.getByRole("region", { name: "Recent activity" })
      ).getByLabelText("Live globe")
    ).toBeDefined()
    expect(screen.getByLabelText("Live globe").textContent).toBe(
      "2 online, 1 locations"
    )
    rerender(
      <PublicDashboard
        snapshot={{ ...data, realtime: 0, realtimeLocations: [] }}
      />
    )
    expect(screen.getByLabelText("Live globe").textContent).toBe(
      "0 online, 0 locations"
    )
    rerender(
      <PublicDashboard snapshot={{ ...data, realtimeLocations: undefined }} />
    )
    expect(screen.queryByLabelText("Live globe")).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Realtime visitor globe" })
    ).toBeNull()
    expect(screen.getByText("Ireland")).toBeDefined()
  })
  it("groups source views into one card and switches their visible rows", () => {
    render(
      <PublicDashboard
        snapshot={snapshot({
          sections: {
            referrers: list("google.com"),
            outboundLinks: list("vendor.example/product"),
            campaigns: list("newsletter / email"),
          },
        })}
      />
    )
    const sources = within(screen.getByRole("region", { name: "Sources" }))
    expect(screen.getAllByRole("region")).toHaveLength(2)
    expect(sources.getByText("google.com")).toBeDefined()
    expect(sources.queryByText("vendor.example/product")).toBeNull()
    expect(
      within(screen.getByRole("region", { name: "Outbound links" })).getByText(
        "vendor.example/product"
      )
    ).toBeDefined()
    expect(sources.queryByRole("button", { name: "Links" })).toBeNull()
    fireEvent.click(sources.getByRole("button", { name: "Campaigns" }))
    expect(sources.getByText("newsletter / email")).toBeDefined()
    expect(
      sources
        .getByRole("button", { name: "Campaigns" })
        .getAttribute("aria-pressed")
    ).toBe("true")
  })

  it("renders only shared metrics and tabs, and falls back when sharing changes", () => {
    const data = snapshot({
      metrics: { visitors: 12, pageviews: 24 },
      sections: { campaigns: list("spring-launch") },
    })
    const { rerender } = render(<PublicDashboard snapshot={data} />)
    expect(screen.getByText("Visitors")).toBeDefined()
    expect(screen.getByText("Pageviews")).toBeDefined()
    expect(screen.queryByText("Visits", { selector: "span" })).toBeNull()
    expect(screen.queryByText("Bounce rate")).toBeNull()
    expect(screen.queryByText("Avg. duration")).toBeNull()
    expect(screen.queryByLabelText("Traffic chart")).toBeNull()
    expect(screen.queryByRole("button", { name: "Referrers" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Links" })).toBeNull()
    expect(screen.queryByRole("region", { name: "Devices" })).toBeNull()
    expect(screen.queryByRole("region", { name: "Locations" })).toBeNull()
    expect(screen.getByText("spring-launch")).toBeDefined()

    rerender(
      <PublicDashboard
        snapshot={snapshot({
          sections: { outboundLinks: list("shared.example") },
        })}
      />
    )
    expect(screen.queryByRole("region", { name: "Overview" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Campaigns" })).toBeNull()
    expect(screen.queryByText("spring-launch")).toBeNull()
    expect(screen.getByText("shared.example")).toBeDefined()
  })

  it("groups device and location tabs while allowing a chart without overview metrics", () => {
    render(
      <PublicDashboard
        snapshot={snapshot({
          chart: [],
          sections: {
            browsers: list("Chrome"),
            operatingSystems: list("macOS"),
            deviceTypes: list("mobile"),
            regions: list("Leinster, Ireland"),
            cities: list("Dublin, Ireland"),
          },
        })}
      />
    )
    expect(screen.getByLabelText("Traffic chart")).toBeDefined()
    expect(screen.queryByText("Visitors")).toBeNull()
    const devices = within(screen.getByRole("region", { name: "Devices" }))
    fireEvent.click(devices.getByRole("button", { name: "OS" }))
    expect(devices.getByText("macOS")).toBeDefined()
    fireEvent.click(devices.getByRole("button", { name: "Devices" }))
    expect(devices.getByText("Mobile")).toBeDefined()
    const locations = within(screen.getByRole("region", { name: "Locations" }))
    expect(locations.queryByRole("button", { name: "Countries" })).toBeNull()
    fireEvent.click(locations.getByRole("button", { name: "Cities" }))
    expect(locations.getByText("Dublin, Ireland")).toBeDefined()
  })
})
