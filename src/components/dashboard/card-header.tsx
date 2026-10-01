import { Button } from "@cloudflare/kumo/components/button"
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
  return (
    <div className="flex w-full min-w-0 items-center justify-between gap-2">
      <span className="shrink-0">{title}</span>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
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
              onClick={(event) => onValueChange(tab.value, event.detail !== 0)}
            >
              {tab.label}
            </Button>
          )
        })}
      </div>
    </div>
  )
}
