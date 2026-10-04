import { useEffect, useRef, useState } from "react"
import { ArrowSquareOutIcon } from "@phosphor-icons/react"
import { Popover } from "@cloudflare/kumo/components/popover"
import type { ReactNode } from "react"
import { externalUrl } from "@/lib/dashboard-links"

export interface RankedListItem {
  key: string
  label: ReactNode
  icon?: ReactNode
  value: number
  href?: string
  details?: ReactNode
  onDetailsOpen?: () => void
}

interface RankedListProps {
  items: Array<RankedListItem>
  valueFormat?: (value: number) => string
  emptyLabel?: string
  /** Animate rows when they arrive after an intentional filter change. */
  animateItems?: boolean
  /**
   * Denominator for the hover-reveal "% of total" figure. Pass the true
   * site-wide total for this metric (e.g. `summary.visits`) — not the sum
   * of just the rows shown here — otherwise the percentages overstate
   * each row's share once the list is truncated to its top N.
   * Defaults to the sum of `items` when omitted.
   */
  total?: number
  metricLabel?: string
  loading?: boolean
  error?: string
  onRetry?: () => void
}

/** Fixed-height container so every panel in the grid lines up, regardless
 * of how many rows it has (§8 — "very minimal two column design"). */
const LIST_HEIGHT = "h-72"

/** A minimal ranked bar-list — label + proportional bar + value, per row.
 * Hovering anywhere over the list slides open each row's share of the
 * total (linear width reveal, no fade) next to its value — the value
 * itself shifts left as the reveal opens, it's not just unmasked. */
export function RankedList({
  items,
  valueFormat,
  emptyLabel = "No data yet",
  animateItems = false,
  total,
  metricLabel,
  loading = false,
  error,
  onRetry,
}: RankedListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showTopFade, setShowTopFade] = useState(false)
  const [showBottomFade, setShowBottomFade] = useState(false)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const update = () => {
      setShowTopFade(el.scrollTop > 4)
      setShowBottomFade(el.scrollHeight - el.scrollTop - el.clientHeight > 4)
    }
    update()

    el.addEventListener("scroll", update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener("scroll", update)
      ro.disconnect()
    }
  }, [items])

  if (loading || error || items.length === 0) {
    return (
      <div className={`flex ${LIST_HEIGHT} items-center justify-center`}>
        <div role="status" className="text-center text-sm text-kumo-subtle">
          <p>{loading ? "Loading…" : (error ?? emptyLabel)}</p>
          {error && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 underline underline-offset-4"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    )
  }

  const max = Math.max(1, ...items.map((i) => i.value))
  const denominator = total ?? items.reduce((sum, i) => sum + i.value, 0)

  return (
    <div className="relative">
      {metricLabel && (
        <p className="mb-1 px-2 text-right text-xs text-kumo-subtle">
          {metricLabel}
        </p>
      )}
      <div className="relative">
        <div
          ref={scrollRef}
          className={`group flex ${LIST_HEIGHT} flex-col gap-0.5 overflow-y-auto pr-1`}
        >
          {items.map((item, index) => {
            const href = externalUrl(item.href)
            const percent =
              denominator > 0 ? Math.round((item.value / denominator) * 100) : 0
            return (
              <div
                key={item.key}
                className={`group/row relative flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-sm text-kumo-subtle ${
                  animateItems ? "ranked-list-filter-enter" : ""
                }`}
                style={
                  animateItems
                    ? { animationDelay: `${index * 30}ms` }
                    : undefined
                }
              >
                <div
                  className="absolute inset-y-0 left-0 rounded-md bg-kumo-tint"
                  style={{
                    width: `${Math.max(3, (item.value / max) * 100)}%`,
                  }}
                />
                <div className="relative flex min-w-0 flex-1 items-center gap-2">
                  {item.icon}
                  {item.details ? (
                    <Popover
                      onOpenChange={(open) => {
                        if (open) item.onDetailsOpen?.()
                      }}
                    >
                      <Popover.Trigger
                        openOnHover
                        delay={350}
                        closeDelay={150}
                        className="min-w-0 cursor-default truncate text-left tracking-wide focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {item.label}
                      </Popover.Trigger>
                      <Popover.Content
                        side="top"
                        align="start"
                        sideOffset={10}
                        className="rounded-md px-2.5 py-1.5"
                      >
                        <Popover.Title className="sr-only">
                          Source details
                        </Popover.Title>
                        {item.details}
                      </Popover.Content>
                    </Popover>
                  ) : (
                    <span className="truncate tracking-wide">{item.label}</span>
                  )}
                  {href && (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={
                        typeof item.label === "string"
                          ? `Open ${item.label} in a new tab`
                          : "Open link in a new tab"
                      }
                      title={href}
                      className="flex size-6 shrink-0 items-center justify-center rounded text-kumo-subtle opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-offset-1 [@media(hover:none)]:opacity-100"
                    >
                      <ArrowSquareOutIcon size={14} aria-hidden="true" />
                    </a>
                  )}
                </div>
                <div className="relative flex shrink-0 items-center">
                  <span className="font-medium text-kumo-default">
                    {valueFormat
                      ? valueFormat(item.value)
                      : item.value.toLocaleString()}
                  </span>
                  <span className="grid grid-cols-[0fr] overflow-hidden transition-[grid-template-columns] duration-100 ease-linear group-hover:grid-cols-[1fr]">
                    <span className="overflow-hidden pl-1 text-xs whitespace-nowrap text-kumo-subtle">
                      · {percent}%
                    </span>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-kumo-base to-transparent transition-opacity duration-200 ${
            showTopFade ? "opacity-100" : "opacity-0"
          }`}
        />
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-kumo-base to-transparent transition-opacity duration-200 ${
            showBottomFade ? "opacity-100" : "opacity-0"
          }`}
        />
      </div>
    </div>
  )
}
