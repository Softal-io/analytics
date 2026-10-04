import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import type { RealtimeVisitorLocation } from "@/lib/realtime"
import { RealtimeGlobe } from "@/components/dashboard/realtime-globe"

export function RecentActivityCard({
  count,
  locations,
  simulate = false,
  unavailable = false,
}: {
  count: number | null
  locations?: Array<RealtimeVisitorLocation>
  simulate?: boolean
  unavailable?: boolean
}) {
  return (
    <LayerCard role="region" aria-label="Recent activity">
      <LayerCard.Secondary>
        <div className="flex w-full items-center justify-between gap-2">
          <span>Recent activity</span>
          <span className="text-xs text-kumo-subtle">Last 5 minutes</span>
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary className="flex min-h-80 flex-1 flex-col overflow-hidden p-0">
        {unavailable ? (
          <div
            role="status"
            className="flex flex-1 items-center justify-center px-4 text-center text-sm text-kumo-subtle"
          >
            Activity updates unavailable. Reconnecting…
          </div>
        ) : count === null ? (
          <div
            className="flex flex-1 items-center justify-center text-sm text-kumo-subtle"
            role="status"
          >
            Connecting to activity updates…
          </div>
        ) : locations !== undefined ? (
          <div className="absolute inset-0">
            <RealtimeGlobe
              count={count}
              locations={locations}
              simulate={simulate}
            />
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-1">
            <span className="text-3xl font-semibold">
              {count.toLocaleString()}
            </span>
            <span className="text-sm text-kumo-subtle">
              {count === 1 ? "visitor" : "visitors"} active in the last 5
              minutes
            </span>
          </div>
        )}
      </LayerCard.Primary>
    </LayerCard>
  )
}
