import {
  ChartLegend,
  ChartPalette,
  TimeseriesChart,
} from "@cloudflare/kumo/components/chart"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { useMemo } from "react"
import type { PublicMetric } from "@/lib/public-options"
import { echarts } from "@/lib/echarts"
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

export function OverviewCard({
  summary,
  metrics = publicMetrics,
  points,
  loading = false,
}: {
  summary: Partial<Record<PublicMetric, number>>
  metrics?: ReadonlyArray<PublicMetric>
  points?: Array<TimeseriesPoint>
  loading?: boolean
}) {
  const series = useMemo(
    () => [
      {
        name: "Pageviews",
        color: ChartPalette.categorical(0),
        data:
          points?.map((p) => [p.timestamp, p.pageviews] as [number, number]) ??
          [],
      },
      {
        name: "Visitors",
        color: ChartPalette.categorical(1),
        data:
          points?.map((p) => [p.timestamp, p.visitors] as [number, number]) ??
          [],
      },
    ],
    [points]
  )

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
                <ChartLegend.LargeItem
                  key={metric}
                  {...metricStyles[metric]}
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
              )
            })}
          </div>
        )}
        {points !== undefined && (
          <TimeseriesChart
            echarts={echarts}
            data={series}
            height={260}
            loading={loading}
          />
        )}
      </LayerCard.Primary>
    </LayerCard>
  )
}
