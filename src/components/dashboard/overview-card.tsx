import { ChartLegend, ChartPalette } from "@cloudflare/kumo/components/chart"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
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

export function OverviewCard({
  summary,
  metrics = publicMetrics,
  points,
  timezone = "UTC",
  loading = false,
}: {
  summary: Partial<Record<PublicMetric, number>>
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
              return (
                <div
                  key={metric}
                  title={metricDescriptions[metric]}
                  className="min-w-0 sm:flex-1"
                >
                  <ChartLegend.LargeItem
                    {...metricStyles[metric]}
                    loading={loading}
                    value={
                      metric === "bounceRate"
                        ? formatPercent(value)
                        : metric === "avgDurationSeconds"
                          ? formatDuration(value)
                          : formatCompactNumber(value)
                    }
                    className={`min-w-0 border-neutral-100 sm:flex-1 ${
                      index % 2 === 0 ? "pr-4" : "border-l pl-4"
                    } ${
                      index === 0
                        ? "sm:border-l-0 sm:pr-4 sm:pl-0"
                        : index === metrics.length - 1
                          ? "sm:border-l sm:pr-0 sm:pl-4"
                          : "sm:border-l sm:px-4"
                    }`}
                  />
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
