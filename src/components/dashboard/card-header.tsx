import { Button } from "@cloudflare/kumo/components/button"
import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"

export function CardHeader({
  title,
  tabs,
  value,
  onValueChange,
}: {
  title: string
  tabs: Array<{
    value: string
    label: ReactNode
    ariaLabel?: string
    title?: string
  }>
  value: string
  onValueChange: (value: string, animate: boolean) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState({ left: false, right: false })

  function revealTab(element: HTMLButtonElement) {
    const scroller = scrollRef.current
    if (!scroller) return
    const button = element.getBoundingClientRect()
    const viewport = scroller.getBoundingClientRect()
    const inset = 12
    if (button.left < viewport.left + inset)
      scroller.scrollLeft += button.left - viewport.left - inset
    else if (button.right > viewport.right - inset)
      scroller.scrollLeft += button.right - viewport.right + inset
  }

  useEffect(() => {
    const scroller = scrollRef.current
    const content = tabsRef.current
    if (!scroller || !content) return
    const update = () => {
      const left = scroller.scrollLeft > 1
      const right =
        scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > 1
      setOverflow((previous) =>
        previous.left === left && previous.right === right
          ? previous
          : { left, right }
      )
    }
    update()
    scroller.addEventListener("scroll", update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(scroller)
    observer.observe(content)
    return () => {
      scroller.removeEventListener("scroll", update)
      observer.disconnect()
    }
  }, [])

  return (
    <div className="flex w-full min-w-0 items-center justify-between gap-2">
      <span className="shrink-0">{title}</span>
      <div
        ref={scrollRef}
        className="card-header-tabs -my-1 ml-auto min-w-0 overflow-x-auto py-1"
        data-overflow-left={overflow.left || undefined}
        data-overflow-right={overflow.right || undefined}
      >
        <div ref={tabsRef} className="flex w-max items-center gap-0.5 px-0.5">
          {tabs.map((tab) => {
            const selected = tab.value === value
            return (
              <Button
                key={tab.value}
                type="button"
                variant="ghost"
                size="xs"
                aria-pressed={selected}
                aria-label={tab.ariaLabel}
                title={tab.title}
                className={
                  selected
                    ? "bg-kumo-fill text-kumo-default hover:bg-kumo-fill"
                    : "text-kumo-subtle opacity-50 hover:opacity-100"
                }
                onFocus={(event) => {
                  if (event.currentTarget.matches(":focus-visible"))
                    revealTab(event.currentTarget)
                }}
                onClick={(event) => {
                  onValueChange(tab.value, event.detail !== 0)
                  revealTab(event.currentTarget)
                }}
              >
                {tab.label}
              </Button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
