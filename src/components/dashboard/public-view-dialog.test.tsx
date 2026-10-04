// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PublicViewDialog } from "./public-view-dialog"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("public globe sharing consent", () => {
  it("keeps existing links opted out and clears consent when city sharing is removed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          slug: "fixture",
          enabled: true,
          metrics: [],
          sections: ["countries", "realtime"],
        })
      )
    )
    vi.stubGlobal("fetch", fetchMock)
    render(
      <PublicViewDialog
        open
        onOpenChange={() => {}}
        siteId="fixture"
        siteName="Fixture"
        trackerOrigin="https://fixture.example"
      />
    )
    const globe = await screen.findByLabelText<HTMLInputElement>(
      "Recent activity globe"
    )
    expect(globe.checked).toBe(false)
    expect(globe.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText("Cities", { exact: true }))
    expect(globe.disabled).toBe(false)
    fireEvent.click(globe)
    expect(globe.checked).toBe(true)

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          enabled: true,
          publicUrl: "https://fixture.example/public/fixture",
        })
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "Save public view" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).sections).toContain(
      "realtimeGlobe"
    )
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: "Save public view",
        }).disabled
      ).toBe(false)
    )
    fireEvent.click(screen.getByLabelText("Cities", { exact: true }))
    expect(globe.checked).toBe(false)
    expect(globe.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText("Cities", { exact: true }))
    expect(globe.checked).toBe(false)
    fireEvent.click(globe)
    fireEvent.click(
      screen.getByLabelText("Visitors active in the last 5 minutes", {
        exact: true,
      })
    )
    expect(globe.checked).toBe(false)
    expect(globe.disabled).toBe(true)
  })
})
