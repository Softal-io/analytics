// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CardHeader } from "./card-header"

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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function partiallyVisibleTab(keyboardFocus: boolean) {
  const onChange = vi.fn()
  render(
    <CardHeader
      title="Locations"
      tabs={[
        { value: "countries", label: "Countries" },
        { value: "cities", label: "Cities" },
      ]}
      value="countries"
      onValueChange={onChange}
    />
  )
  const button = screen.getByRole<HTMLButtonElement>("button", {
    name: "Cities",
  })
  const scroller = button.closest<HTMLDivElement>(".card-header-tabs")!
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(
    new DOMRect(100, 20, 168, 28)
  )
  vi.spyOn(button, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(236 - scroller.scrollLeft, 24, 45, 20)
  )
  // jsdom has no keyboard/pointer modality tracking for :focus-visible.
  vi.spyOn(button, "matches").mockReturnValue(keyboardFocus)
  return { button, scroller, onChange }
}

describe("overflow tab selection", () => {
  it("keeps the pointer target still until a click selects the tab", () => {
    const { button, scroller, onChange } = partiallyVisibleTab(false)
    fireEvent.pointerDown(button)
    fireEvent.mouseDown(button)
    fireEvent.focus(button)
    expect(scroller.scrollLeft).toBe(0)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.pointerUp(button)
    fireEvent.mouseUp(button)
    fireEvent.click(button, { detail: 1 })
    expect(onChange).toHaveBeenCalledExactlyOnceWith("cities", true)
    expect(scroller.scrollLeft).toBe(25)
  })
  it("reveals keyboard focus immediately and selects without animation", () => {
    const { button, scroller, onChange } = partiallyVisibleTab(true)
    fireEvent.focus(button)
    expect(scroller.scrollLeft).toBe(25)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(button, { detail: 0 })
    expect(onChange).toHaveBeenCalledExactlyOnceWith("cities", false)
    expect(scroller.scrollLeft).toBe(25)
  })
})
