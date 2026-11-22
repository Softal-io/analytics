// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RealtimeGlobe } from "@/components/dashboard/realtime-globe"

vi.mock("cobe", () => ({
  default: () => ({ update: vi.fn(), destroy: vi.fn() }),
}))

const dublin = { country: "IE", region: "L", city: "Dublin" }
const locations = [
  { latitude: 53.3, longitude: -6.2, count: 2, place: dublin },
  { latitude: 10, longitude: 10, count: 1 },
]

describe("realtime globe avatars", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    )
    vi.stubGlobal("matchMedia", () => ({ matches: true }))
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("filters to an avatar's place and leaves unknown places unclickable", () => {
    const onSelect = vi.fn()
    const placeFilter = vi.fn(() => ({ selected: false, onSelect }))
    render(
      <RealtimeGlobe
        count={3}
        locations={locations}
        placeFilter={placeFilter}
      />
    )
    const buttons = screen.getAllByRole("button")
    expect(buttons).toHaveLength(1)
    fireEvent.click(
      screen.getByRole("button", {
        name: "Filter the dashboard to Dublin, Ireland",
      })
    )
    expect(placeFilter).toHaveBeenCalledWith(dublin)
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it("marks the selected place as pressed", () => {
    render(
      <RealtimeGlobe
        count={2}
        locations={locations}
        placeFilter={() => ({ selected: true, onSelect: vi.fn() })}
      />
    )
    expect(
      screen.getByRole("button", { name: "Remove the Dublin, Ireland filter" })
    ).toHaveProperty("ariaPressed", "true")
  })

  it("renders plain avatars without a place filter", () => {
    render(<RealtimeGlobe count={3} locations={locations} />)
    expect(screen.queryByRole("button")).toBeNull()
  })
})
