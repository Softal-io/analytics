import { ChartLegend, ChartPalette } from "@cloudflare/kumo/components/chart"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { Popover } from "@cloudflare/kumo/components/popover"
import { TrafficChart } from "./traffic-chart"
import type { PublicMetric } from "@/lib/public-options"
import {
  formatCompactNumber,
  formatDuration,
  formatPercent,
} from "@/lib/format"
import { publicMetrics } from "@/lib/public-options"

interface TimeseriesPoint {
  timestamp: number
  pageviews: number
  visitors: number
}

const metricStyles = {
  visitors: { name: "Visitors", color: ChartPalette.categorical(1) },
  visits: { name: "Visits", color: ChartPalette.categorical(2) },
  pageviews: { name: "Pageviews", color: ChartPalette.categorical(0) },
  bounceRate: { name: "Bounce rate", color: ChartPalette.semantic("Warning") },
  avgDurationSeconds: {
    name: "Avg. duration",
    color: ChartPalette.semantic("Neutral"),
  },
}

const metricDescriptions = {
  visitors:
    "Distinct recognized visitors across the selected date range. Daily chart counts can include the same visitor on different days.",
  visits: "Sessions end after 30 minutes without tracked activity.",
  pageviews: "Total recorded page loads and route changes.",
  bounceRate:
    "Visits without engagement: no more than 10 seconds of active time, no second pageview, and no outbound click or custom event. Historical visits use the previous pageview-based definition.",
  avgDurationSeconds:
    "Average visible, focused time per visit, including single-page visits. Historical visits retain first-to-last-pageview estimates.",
}

const changeDirections = {
  up: { arrow: "↑", spoken: "Up " },
  down: { arrow: "↓", spoken: "Down " },
  flat: { arrow: "→", spoken: "Unchanged, " },
}

/** Change against the earlier period, coloured by whether it is an improvement. */
function metricChange(
  metric: PublicMetric,
  value: number,
  previous: number | undefined
): { label: string; direction: "up" | "down" | "flat"; good: boolean } | null {
  if (previous === undefined) return null
  // A rate compares in percentage points; a relative change of a rate misleads.
  const change =
    metric === "bounceRate"
      ? (value - previous) * 100
      : previous > 0
        ? ((value - previous) / previous) * 100
        : null
  if (change === null || !Number.isFinite(change)) return null
  const rounded =
    Math.abs(change) >= 10 ? Math.round(change) : Number(change.toFixed(1))
  const direction = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat"
  return {
    label: `${Math.abs(rounded)}${metric === "bounceRate" ? " pts" : "%"}`,
    direction,
    // A lower bounce rate is the improvement.
    good: metric === "bounceRate" ? direction === "down" : direction === "up",
  }
}

export function OverviewCard({
  summary,
  comparison,
  metrics = publicMetrics,
  points,
  timezone = "UTC",
  loading = false,
}: {
  summary: Partial<Record<PublicMetric, number>>
  /**
   * The same metrics for an earlier period, with what that period is in
   * words: a headline, then supporting lines.
   */
  comparison?: {
    previous: Partial<Record<PublicMetric, number>>
    lines: Array<string>
  }
  metrics?: ReadonlyArray<PublicMetric>
  points?: Array<TimeseriesPoint>
  timezone?: string
  loading?: boolean
}) {
  if (metrics.length === 0 && points === undefined) return null

  return (
    <LayerCard role="region" aria-label="Overview">
      <LayerCard.Secondary>Overview</LayerCard.Secondary>
      <LayerCard.Primary className="h-full p-2.5">
        {metrics.length > 0 && (
          <div className="mb-3 grid grid-cols-2 gap-y-3 px-1 sm:flex sm:flex-wrap">
            {metrics.map((metric, index) => {
              const value = summary[metric] ?? 0
              const change =
                loading || !comparison
                  ? null
                  : metricChange(metric, value, comparison.previous[metric])
              return (
                // The divider belongs to the tile, so it spans the change
                // figure too when that wraps under the number.
                <div
                  key={metric}
                  title={metricDescriptions[metric]}
                  className={`min-w-0 border-neutral-100 py-2 sm:flex-1 ${
                    index % 2 === 0 ? "pr-4" : "border-l pl-4"
                  } ${
                    index === 0
                      ? "sm:border-l-0 sm:pr-4 sm:pl-0"
                      : index === metrics.length - 1
                        ? "sm:border-l sm:pr-0 sm:pl-4"
                        : "sm:border-l sm:px-4"
                  }`}
                >
                  {loading ? (
                    <ChartLegend.LargeItem loading className="min-w-0 py-0" />
                  ) : (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block size-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor: metricStyles[metric].color,
                          }}
                        />
                        <span className="truncate text-xs">
                          {metricStyles[metric].name}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
                        <span className="text-lg leading-none font-medium">
                          {metric === "bounceRate"
                            ? formatPercent(value)
                            : metric === "avgDurationSeconds"
                              ? formatDuration(value)
                              : formatCompactNumber(value)}
                        </span>
                        {change && comparison && (
                          // A popover, unlike a tooltip, also opens on a tap.
                          <Popover>
                            <Popover.Trigger
                              openOnHover
                              delay={150}
                              closeDelay={100}
                              // An empty title keeps the tile's own
                              // description from showing over the popover.
                              title=""
                              className={`cursor-default rounded-sm text-xs leading-none font-medium whitespace-nowrap tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 ${
                                change.direction === "flat"
                                  ? "text-kumo-subtle"
                                  : change.good
                                    ? "text-kumo-success"
                                    : "text-kumo-danger"
                              }`}
                            >
                              <span aria-hidden="true">
                                {changeDirections[change.direction].arrow}{" "}
                                {change.label}
                              </span>
                              <span className="sr-only">
                                {changeDirections[change.direction].spoken}
                                {change.label}
                              </span>
                            </Popover.Trigger>
                            <Popover.Content
                              side="bottom"
                              align="start"
                              sideOffset={8}
                              className="rounded-md px-2.5 py-1.5 text-xs"
                            >
                              <Popover.Title className="sr-only">
                                What this change is compared with
                              </Popover.Title>
                              {comparison.lines.map((line, lineIndex) => (
                                <p
                                  key={line}
                                  className={`whitespace-nowrap ${
                                    lineIndex === 0
                                      ? "font-medium text-kumo-default"
                                      : "text-kumo-subtle"
                                  }`}
                                >
                                  {line}
                                </p>
                              ))}
                            </Popover.Content>
                          </Popover>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {points !== undefined && (
          <TrafficChart points={points} timezone={timezone} loading={loading} />
        )}
      </LayerCard.Primary>
    </LayerCard>
  )
}
