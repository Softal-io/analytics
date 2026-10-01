// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type * as ChartModule from "@cloudflare/kumo/components/chart"
import type { PublicSnapshot } from "@/lib/public-snapshot"
import { PublicDashboard } from "@/components/dashboard/public-dashboard"

vi.mock("@/lib/echarts", () => ({ echarts: {} }))
vi.mock("@cloudflare/kumo/components/chart", async (importOriginal) => {
  const original = await importOriginal<typeof ChartModule>()
  return {
    ...original,
    TimeseriesChart: () => <div aria-label="Traffic chart" />,
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
    expect(screen.getAllByRole("region")).toHaveLength(1)
    expect(sources.getByText("google.com")).toBeDefined()
    expect(sources.queryByText("vendor.example/product")).toBeNull()
    fireEvent.click(sources.getByRole("button", { name: "Links" }))
    expect(sources.getByText("vendor.example/product")).toBeDefined()
    expect(sources.queryByText("google.com")).toBeNull()
    fireEvent.click(sources.getByRole("button", { name: "UTM" }))
    expect(sources.getByText("newsletter / email")).toBeDefined()
    expect(
      sources.getByRole("button", { name: "UTM" }).getAttribute("aria-pressed")
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
    expect(screen.queryByText("Visits")).toBeNull()
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
    expect(screen.queryByRole("button", { name: "UTM" })).toBeNull()
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
