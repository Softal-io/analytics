import { XIcon } from "@phosphor-icons/react"
import type { VisitFilterKey, VisitFilters } from "@/lib/visit-filter-schema"
import {
  formatCampaign,
  formatCountry,
  formatDeviceType,
  formatReferrer,
} from "@/lib/format"
import { visitFilterKeys } from "@/lib/visit-filter-schema"

const filterNames: Record<VisitFilterKey, string> = {
  page: "Page",
  entry: "Entry page",
  exit: "Exit page",
  referrer: "Referrer",
  utm: "Campaign",
  browser: "Browser",
  os: "OS",
  device: "Device",
  country: "Country",
  region: "Region",
  city: "City",
  link: "Outbound link",
  event: "Event",
  paid: "Payment",
}

function filterValueLabel(key: VisitFilterKey, value: string): string {
  if (key === "paid") return "Paying visits"
  if (key === "referrer") return formatReferrer(value)
  if (key === "device") return formatDeviceType(value)
  if (key === "country") return formatCountry(value)
  if (key === "link") return value.replace(/^https?:\/\//, "")
  if (key === "utm") {
    try {
      const [source, medium, campaign] = JSON.parse(value) as Array<string>
      return formatCampaign(source, medium, campaign)
    } catch {
      return value
    }
  }
  return value
}

/** The active filters, each removable, so a filtered dashboard is never mistaken for the whole. */
export function FilterBar({
  filters,
  onRemove,
  onClear,
}: {
  filters: VisitFilters
  onRemove: (key: VisitFilterKey) => void
  onClear: () => void
}) {
  const active = visitFilterKeys.filter((key) => filters[key])
  if (active.length === 0) return null
  return (
    <div
      role="group"
      aria-label="Active filters"
      className="flex flex-wrap items-center gap-1.5 text-sm"
    >
      <span className="text-kumo-subtle">Showing visits where</span>
      {active.map((key) => (
        <span
          key={key}
          className="flex max-w-full min-w-0 items-center gap-1 rounded-md bg-kumo-fill py-0.5 pr-0.5 pl-2"
        >
          <span className="shrink-0 text-kumo-subtle">{filterNames[key]}</span>
          <span className="truncate font-medium text-kumo-default">
            {filterValueLabel(key, filters[key]!)}
          </span>
          <button
            type="button"
            aria-label={`Remove ${filterNames[key]} filter`}
            onClick={() => onRemove(key)}
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-kumo-subtle hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-offset-1"
          >
            <XIcon size={12} weight="bold" aria-hidden="true" />
          </button>
        </span>
      ))}
      {active.length > 1 && (
        <button
          type="button"
          onClick={onClear}
          className="cursor-pointer px-1 text-kumo-subtle underline underline-offset-4 hover:text-kumo-default"
        >
          Clear all
        </button>
      )}
    </div>
  )
}
