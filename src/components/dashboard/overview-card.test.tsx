// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { OverviewCard } from "@/components/dashboard/overview-card"
import { describeComparison } from "@/lib/format"

afterEach(cleanup)

const summary = {
  visitors: 110,
  visits: 90,
  pageviews: 200,
  bounceRate: 0.2,
  avgDurationSeconds: 60,
}

describe("overview change figures", () => {
  it("shows each change and treats a lower bounce rate as the improvement", () => {
    render(
      <OverviewCard
        summary={summary}
        comparison={{
          previous: {
            visitors: 100,
            visits: 100,
            pageviews: 200,
            bounceRate: 0.25,
            avgDurationSeconds: 0,
          },
          lines: ["Compared with yesterday", "20 Nov"],
        }}
      />
    )
    const up = screen.getByRole("button", { name: /Up 10%/ })
    const down = screen.getByRole("button", { name: /Down 10%/ })
    const flat = screen.getByRole("button", { name: /Unchanged, 0%/ })
    const bounce = screen.getByRole("button", { name: /Down 5 pts/ })
    expect(up.className).toContain("text-kumo-success")
    expect(down.className).toContain("text-kumo-danger")
    expect(flat.className).toContain("text-kumo-subtle")
    expect(bounce.className).toContain("text-kumo-success")
    // Nothing to divide by: a duration that was zero shows no change.
    expect(screen.getAllByRole("button")).toHaveLength(4)

    // A click, which is also what a tap sends, opens the explanation.
    fireEvent.click(up)
    expect(screen.getByText("Compared with yesterday")).toBeTruthy()
    expect(screen.getByText("20 Nov")).toBeTruthy()
  })

  it("shows no change without an earlier period, or while loading", () => {
    const { rerender } = render(<OverviewCard summary={summary} />)
    expect(screen.getByText("110")).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
    rerender(
      <OverviewCard
        summary={summary}
        loading
        comparison={{ previous: summary, lines: ["Compared with yesterday"] }}
      />
    )
    expect(screen.queryByRole("button")).toBeNull()
  })
})

describe("comparison wording", () => {
  it("names the period, its dates, and a cut-off at the current time", () => {
    expect(
      describeComparison("today", {
        range: { fromDate: "2026-11-20", toDate: "2026-11-20" },
        untilSec: 1,
      })
    ).toEqual([
      "Compared with yesterday",
      "20 Nov",
      "Up to the same time of day",
    ])
    expect(
      describeComparison("yesterday", {
        range: { fromDate: "2026-11-19", toDate: "2026-11-19" },
      })
    ).toEqual(["Compared with the day before", "19 Nov"])
    expect(
      describeComparison("7d", {
        range: { fromDate: "2026-11-08", toDate: "2026-11-14" },
        untilSec: 1,
      })[1]
    ).toBe("8 Nov to 14 Nov")
  })

  it("adds years when the earlier period crosses a year boundary", () => {
    expect(
      describeComparison("1y", {
        range: { fromDate: "2024-11-22", toDate: "2025-11-21" },
        untilSec: 1,
      })
    ).toEqual([
      "Compared with the previous 12 months",
      "22 Nov 2024 to 21 Nov 2025",
      "Up to the same time of day",
    ])
  })
})
