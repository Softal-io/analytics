import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { GlobeIcon } from "@phosphor-icons/react"
import { useState } from "react"
import type { PublicSection } from "@/lib/public-options"
import type { PublicSnapshot } from "@/lib/public-snapshot"
import { CardHeader } from "@/components/dashboard/card-header"
import {
  BrowserMark,
  DeviceMark,
  OsMark,
} from "@/components/dashboard/device-icons"
import { CountryFlag, SourceIcon } from "@/components/dashboard/icons"
import { OverviewCard } from "@/components/dashboard/overview-card"
import { RankedList } from "@/components/dashboard/ranked-list"
import { RealtimeGlobe } from "@/components/dashboard/realtime-globe"
import { publicMetrics } from "@/lib/public-options"

type ListSection = Exclude<
  PublicSection,
  "chart" | "realtime" | "realtimeGlobe"
>
interface PublicTab {
  value: ListSection
  label: string
  emptyLabel?: string
}

const sourceTabs: Array<PublicTab> = [
  { value: "referrers", label: "Referrers", emptyLabel: "No referrers yet" },
  {
    value: "outboundLinks",
    label: "Links",
    emptyLabel: "No outbound link clicks yet",
  },
  { value: "campaigns", label: "UTM", emptyLabel: "No UTM traffic yet" },
]
const deviceTabs: Array<PublicTab> = [
  { value: "browsers", label: "Browsers" },
  { value: "operatingSystems", label: "OS" },
  { value: "deviceTypes", label: "Devices" },
]
const locationTabs: Array<PublicTab> = [
  { value: "countries", label: "Countries", emptyLabel: "No country data yet" },
  { value: "regions", label: "Regions", emptyLabel: "No region data yet" },
  { value: "cities", label: "Cities", emptyLabel: "No city data yet" },
]

function PublicListCard({
  title,
  tabs,
  sections,
  realtime,
  realtimeLocations,
}: {
  title: string
  tabs: Array<PublicTab>
  sections: PublicSnapshot["sections"]
  realtime?: number
  realtimeLocations?: PublicSnapshot["realtimeLocations"]
}) {
  const [selected, setSelected] = useState(tabs[0].value)
  const [animateItems, setAnimateItems] = useState(false)
  const [showGlobe, setShowGlobe] = useState(false)
  const visibleTabs = tabs.filter((tab) => sections[tab.value] !== undefined)
  if (visibleTabs.length === 0) return null
  const active =
    visibleTabs.find((tab) => tab.value === selected) ?? visibleTabs[0]
  const list = sections[active.value]!
  const hasGlobe =
    title === "Locations" &&
    realtime !== undefined &&
    realtimeLocations !== undefined
  const globeActive = hasGlobe && showGlobe

  return (
    <LayerCard role="region" aria-label={title}>
      <LayerCard.Secondary>
        <CardHeader
          title={title}
          tabs={
            hasGlobe
              ? [
                  ...visibleTabs,
                  {
                    value: "globe",
                    label: <GlobeIcon className="size-4" />,
                    ariaLabel: "Realtime visitor globe",
                    title: "Realtime visitor globe",
                  },
                ]
              : visibleTabs
          }
          value={globeActive ? "globe" : active.value}
          onValueChange={(value, animate) => {
            setShowGlobe(value === "globe")
            if (value === "globe") return
            setSelected(value as ListSection)
            setAnimateItems(animate)
          }}
        />
      </LayerCard.Secondary>
      <LayerCard.Primary
        className={globeActive ? "h-80 overflow-hidden p-0" : "h-full p-2.5"}
      >
        {globeActive ? (
          <RealtimeGlobe count={realtime} locations={realtimeLocations} />
        ) : (
          <RankedList
            key={active.value}
            items={list.rows.map((row, index) => ({
              key: `${index}:${row.label}`,
              label:
                active.value === "deviceTypes"
                  ? row.label.charAt(0).toUpperCase() + row.label.slice(1)
                  : row.label,
              icon:
                active.value === "referrers" ? (
                  <SourceIcon domain={row.label} />
                ) : active.value === "browsers" ? (
                  <BrowserMark browser={row.label} />
                ) : active.value === "operatingSystems" ? (
                  <OsMark os={row.label} />
                ) : active.value === "deviceTypes" ? (
                  <DeviceMark device={row.label} />
                ) : row.country ? (
                  <CountryFlag country={row.country} />
                ) : undefined,
              value: row.count,
            }))}
            total={list.total}
            emptyLabel={active.emptyLabel}
            animateItems={animateItems}
          />
        )}
      </LayerCard.Primary>
    </LayerCard>
  )
}

export function PublicDashboard({ snapshot }: { snapshot: PublicSnapshot }) {
  const metrics = publicMetrics.filter(
    (metric) => snapshot.metrics[metric] !== undefined
  )
  return (
    <>
      <OverviewCard
        summary={snapshot.metrics}
        metrics={metrics}
        points={snapshot.chart}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PublicListCard
          title="Pages"
          tabs={[{ value: "pages", label: "Top" }]}
          sections={snapshot.sections}
        />
        <PublicListCard
          title="Sources"
          tabs={sourceTabs}
          sections={snapshot.sections}
        />
        <PublicListCard
          title="Devices"
          tabs={deviceTabs}
          sections={snapshot.sections}
        />
        <PublicListCard
          title="Locations"
          tabs={locationTabs}
          sections={snapshot.sections}
          realtime={snapshot.realtime}
          realtimeLocations={snapshot.realtimeLocations}
        />
        {snapshot.sections.events !== undefined && (
          <LayerCard className="sm:col-span-2">
            <LayerCard.Secondary>Custom events</LayerCard.Secondary>
            <LayerCard.Primary className="h-full p-2.5">
              <RankedList
                items={snapshot.sections.events.rows.map((row, index) => ({
                  key: `${index}:${row.label}`,
                  label: row.label,
                  value: row.count,
                }))}
                total={snapshot.sections.events.total}
                emptyLabel="No custom events yet"
              />
            </LayerCard.Primary>
          </LayerCard>
        )}
      </div>
    </>
  )
}
