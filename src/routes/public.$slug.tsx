import { Badge } from "@cloudflare/kumo/components/badge"
import { Button } from "@cloudflare/kumo/components/button"
import {
  ChartPalette,
  TimeseriesChart,
} from "@cloudflare/kumo/components/chart"
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { CaretDownIcon } from "@phosphor-icons/react"
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { useEffect, useState } from "react"
import { z } from "zod"
import type { PublicMetric } from "@/lib/public-options"
import { RankedList } from "@/components/dashboard/ranked-list"
import { SourceIcon } from "@/components/dashboard/icons"
import { echarts } from "@/lib/echarts"
import {
  formatCompactNumber,
  formatDuration,
  formatPercent,
} from "@/lib/format"
import {
  metricLabels,
  publicMetrics,
  publicSections,
  sectionLabels,
} from "@/lib/public-options"

const ranges = ["today", "7d", "30d", "6m", "1y"] as const
const rangeLabels = [
  "Today",
  "Last 7 days",
  "Last 30 days",
  "Last 6 months",
  "Last 12 months",
]
const getPublicData = createServerFn()
  .validator(z.object({ slug: z.string().max(80), range: z.enum(ranges) }))
  .handler(async ({ data }) => {
    const { loadPublicSnapshot } = await import("@/lib/public-data")
    const snapshot = await loadPublicSnapshot(data.slug, data.range)
    if (!snapshot) throw notFound()
    return snapshot
  })
export const Route = createFileRoute("/public/$slug")({
  validateSearch: z.object({ range: z.enum(ranges).optional() }),
  loaderDeps: ({ search }) => ({ range: search.range ?? "30d" }),
  loader: ({ params, deps }) =>
    getPublicData({ data: { slug: params.slug, range: deps.range } }),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `${loaderData.site.name} · Public analytics`
          : "Public analytics",
      },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: PublicView,
  notFoundComponent: () => (
    <main className="mx-auto max-w-lg p-8">
      <h1 className="text-xl font-semibold">This public view is unavailable</h1>
      <p className="mt-2 text-sm text-kumo-subtle">
        The link may be incorrect, or the website owner has stopped sharing this
        view.
      </p>
    </main>
  ),
})

function metricValue(metric: PublicMetric, value: number) {
  return metric === "bounceRate"
    ? formatPercent(value)
    : metric === "avgDurationSeconds"
      ? formatDuration(value)
      : formatCompactNumber(value)
}

function PublicView() {
  const snapshot = Route.useLoaderData()
  const { slug } = Route.useParams()
  const { range = "30d" } = Route.useSearch()
  const navigate = useNavigate()
  const [live, setLive] = useState(snapshot.realtime)
  useEffect(() => {
    setLive(snapshot.realtime)
    if (snapshot.realtime === undefined) return
    const controller = new AbortController()
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(
          `/api/public/${encodeURIComponent(slug)}/realtime`,
          { signal: controller.signal }
        )
        if (response.ok)
          setLive(
            z
              .object({ count: z.number().int().nonnegative() })
              .parse(await response.json()).count
          )
        else {
          setLive(undefined)
          window.clearInterval(interval)
        }
      } catch {
        /* Keep the last count during temporary connection failures. */
      }
    }, 20_000)
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [slug, snapshot.realtime])
  const metrics = publicMetrics.filter(
    (key) => snapshot.metrics[key] !== undefined
  )
  const chartData = snapshot.chart
    ? [
        {
          name: "Pageviews",
          color: ChartPalette.categorical(0),
          data: snapshot.chart.map(
            (point) => [point.timestamp, point.pageviews] as [number, number]
          ),
        },
        {
          name: "Visitors",
          color: ChartPalette.categorical(1),
          data: snapshot.chart.map(
            (point) => [point.timestamp, point.visitors] as [number, number]
          ),
        },
      ]
    : null
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <SourceIcon domain={snapshot.site.domain} />
            <h1 className="font-semibold">{snapshot.site.name}</h1>
            {live !== undefined && (
              <Badge appearance="dot" variant="success">
                {live} online
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-kumo-subtle">
            Public analytics · {snapshot.site.domain}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <Button variant="ghost" aria-label="Select date range">
                {rangeLabels[ranges.indexOf(range)]}
                <CaretDownIcon
                  className="size-4 text-neutral-500"
                  weight="bold"
                />
              </Button>
            }
          />
          <DropdownMenu.Content align="end" className="t-dropdown min-w-44">
            {ranges.map((value, index) => (
              <DropdownMenu.Item
                key={value}
                selected={range === value}
                onClick={() =>
                  navigate({
                    to: "/public/$slug",
                    params: { slug },
                    search: { range: value },
                  })
                }
              >
                {rangeLabels[index]}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu>
      </header>
      {(metrics.length > 0 || chartData) && (
        <LayerCard>
          <LayerCard.Secondary>Overview</LayerCard.Secondary>
          <LayerCard.Primary className="p-3">
            {metrics.length > 0 && (
              <div className="flex flex-wrap gap-x-8 gap-y-4 px-1 py-2">
                {metrics.map((metric) => (
                  <div key={metric}>
                    <p className="text-xs text-kumo-subtle">
                      {metricLabels[metric]}
                    </p>
                    <p className="mt-1 text-2xl font-semibold">
                      {metricValue(metric, snapshot.metrics[metric]!)}
                    </p>
                  </div>
                ))}
              </div>
            )}
            {chartData && (
              <TimeseriesChart
                echarts={echarts}
                data={chartData}
                height={260}
              />
            )}
          </LayerCard.Primary>
        </LayerCard>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {publicSections.map((section) => {
          const list = snapshot.sections[section]
          return list ? (
            <LayerCard key={section}>
              <LayerCard.Secondary>
                {sectionLabels[section]}
              </LayerCard.Secondary>
              <LayerCard.Primary className="p-2.5">
                <RankedList
                  items={list.rows.map((row, index) => ({
                    key: `${index}:${row.label}`,
                    label: row.label,
                    value: row.count,
                  }))}
                  total={list.total}
                />
              </LayerCard.Primary>
            </LayerCard>
          ) : null
        })}
      </div>
      <p className="text-center text-xs text-kumo-subtle">
        {snapshot.range.fromDate} to {snapshot.range.toDate} · Shared by the
        website owner
      </p>
    </main>
  )
}
