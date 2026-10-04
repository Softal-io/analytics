import { useMemo } from "react"
import { Chart, ChartPalette } from "@cloudflare/kumo/components/chart"
import type { KumoChartOption } from "@cloudflare/kumo/components/chart"
import { echarts } from "@/lib/echarts"

interface Point {
  timestamp: number
  pageviews: number
  visitors: number
}
export function chartTimestamp(
  timestamp: number,
  timezone: string,
  hourly = false,
  tooltip = false
) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    ...(hourly || tooltip
      ? {
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "shortOffset" as const,
        }
      : {}),
    ...(!hourly || tooltip
      ? {
          day: "2-digit",
          month: "short",
          ...(tooltip ? { year: "numeric" as const } : {}),
        }
      : {}),
  }).format(timestamp)
}

/** A shared formatter keeps bucket labels and hover details in the site's timezone. */
export function TrafficChart({
  points,
  timezone,
  loading,
}: {
  points: Array<Point>
  timezone: string
  loading: boolean
}) {
  const options = useMemo<KumoChartOption>(() => {
    const hourly =
      points.length > 1 && points[1].timestamp - points[0].timestamp <= 3600000
    const colors = [ChartPalette.categorical(0), ChartPalette.categorical(1)]
    return {
      animation: false,
      aria: { enabled: true },
      grid: { left: 10, right: 12, top: 15, bottom: 10, containLabel: true },
      xAxis: {
        type: "time",
        splitNumber: 5,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          hideOverlap: true,
          formatter: (value: number) => chartTimestamp(value, timezone, hourly),
        },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        axisLine: { show: false },
        splitLine: { lineStyle: { type: "dashed", color: "#e5e5e5" } },
      },
      tooltip: {
        trigger: "axis",
        confine: true,
        renderMode: "richText",
        backgroundColor: "#fff",
        borderColor: "#e5e5e5",
        borderWidth: 1,
        padding: 12,
        textStyle: {
          fontFamily: "Inter Variable, sans-serif",
          color: "#171717",
          fontSize: 12,
          rich: {
            title: { fontWeight: "bold", padding: [0, 0, 6, 0] },
            page: { color: colors[0] },
            visitor: { color: colors[1] },
          },
        },
        // Rich-text rendering uses plain text, without parsing HTML from analytics data.
        dangerousHtmlFormatter: (params) => {
          const rows = Array.isArray(params) ? params : [params]
          const first = rows[0]
          const data = first.value as [number, number] | undefined
          if (!data) return ""
          return (
            `{title|${chartTimestamp(Number(data[0]), timezone, hourly, true)}}\n` +
            rows
              .map((row) => {
                const value = row.value as [number, number]
                return `{${row.seriesIndex === 0 ? "page" : "visitor"}|●} ${row.seriesIndex === 0 ? "Pageviews" : "Visitors"}    ${Number(value[1]).toLocaleString()}`
              })
              .join("\n")
          )
        },
      },
      series: (["pageviews", "visitors"] as const).map((key, index) => ({
        type: "line",
        name: index === 0 ? "Pageviews" : "Visitors",
        showSymbol: false,
        symbolSize: 6,
        lineStyle: { width: 2 },
        itemStyle: { color: colors[index] },
        data: points.map((point) => [point.timestamp, point[key]]),
      })),
    }
  }, [points, timezone])
  return loading ? (
    <div
      className="flex h-[260px] items-center justify-center text-sm text-kumo-subtle"
      role="status"
    >
      Loading chart…
    </div>
  ) : (
    <Chart echarts={echarts} options={options} height={260} />
  )
}
