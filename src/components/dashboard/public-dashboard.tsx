import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { useState } from "react"
import { SourceDetailsContent, sourceHref } from "./source-details"
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
import { RecentActivityCard } from "@/components/dashboard/recent-activity-card"
import { publicMetrics } from "@/lib/public-options"
import { externalUrl, pageUrl } from "@/lib/dashboard-links"
import { useSourceDetails } from "@/hooks/use-source-details"

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
  { value: "campaigns", label: "Campaigns", emptyLabel: "No UTM traffic yet" },
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
  siteDomain,
  sourceDetailsUrl,
}: {
  title: string
  tabs: Array<PublicTab>
  sections: PublicSnapshot["sections"]
  siteDomain?: string
  sourceDetailsUrl?: string
}) {
  const [selected, setSelected] = useState(tabs[0].value)
  const [animateItems, setAnimateItems] = useState(false)
  const details = useSourceDetails(sourceDetailsUrl)
  const visibleTabs = tabs.filter((tab) => sections[tab.value] !== undefined)
  if (visibleTabs.length === 0) return null
  const active =
    visibleTabs.find((tab) => tab.value === selected) ?? visibleTabs[0]
  const list = sections[active.value]!

  return (
    <LayerCard role="region" aria-label={title}>
      <LayerCard.Secondary>
        <CardHeader
          title={title}
          tabs={visibleTabs}
          value={active.value}
          onValueChange={(value, animate) => {
            setSelected(value as ListSection)
            setAnimateItems(animate)
          }}
        />
      </LayerCard.Secondary>
      <LayerCard.Primary className="h-full p-2.5">
        <RankedList
          key={active.value}
          items={list.rows.map((row, index) => {
            const view = active.value === "campaigns" ? "utm" : "referrer"
            const loaded =
              row.details && row.key
                ? details.get(row.key, view, row.details)
                : undefined
            const source = loaded?.details ?? row.details
            return {
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
              details: source ? (
                <SourceDetailsContent
                  details={source}
                  loading={loaded?.loading}
                  error={loaded?.error}
                  retry={loaded?.retry}
                />
              ) : undefined,
              onDetailsOpen: row.key
                ? () => {
                    void details.load(row.key!, view)
                  }
                : undefined,
              href:
                active.value === "pages" && siteDomain
                  ? pageUrl(siteDomain, row.label)
                  : active.value === "referrers" || active.value === "campaigns"
                    ? sourceHref(
                        source,
                        active.value === "referrers" ? row.label : undefined
                      )
                    : undefined,
            }
          })}
          metricLabel={title === "Pages" ? "Pageviews" : "Visits"}
          total={list.total}
          emptyLabel={active.emptyLabel}
          animateItems={animateItems}
        />
      </LayerCard.Primary>
    </LayerCard>
  )
}

export function PublicDashboard({
  snapshot,
  activityUnavailable = false,
}: {
  snapshot: PublicSnapshot
  activityUnavailable?: boolean
}) {
  const metrics = publicMetrics.filter(
    (metric) => snapshot.metrics[metric] !== undefined
  )
  return (
    <>
      <OverviewCard
        timezone={snapshot.site.timezone}
        summary={snapshot.metrics}
        metrics={metrics}
        points={snapshot.chart}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PublicListCard
          title="Pages"
          siteDomain={snapshot.site.domain}
          tabs={[{ value: "pages", label: "Top" }]}
          sections={snapshot.sections}
        />
        {snapshot.sections.outboundLinks !== undefined && (
          <LayerCard role="region" aria-label="Outbound links">
            <LayerCard.Secondary>Outbound links</LayerCard.Secondary>
            <LayerCard.Primary className="h-full p-2.5">
              <RankedList
                items={snapshot.sections.outboundLinks.rows.map(
                  (row, index) => ({
                    key: `${index}:${row.label}`,
                    label: row.label,
                    href: externalUrl(row.url),
                    value: row.count,
                  })
                )}
                metricLabel="Clicks"
                total={snapshot.sections.outboundLinks.total}
                emptyLabel="No outbound link clicks yet"
              />
            </LayerCard.Primary>
          </LayerCard>
        )}
        <PublicListCard
          title="Sources"
          sourceDetailsUrl={snapshot.sourceDetailsUrl}
          tabs={sourceTabs}
          sections={snapshot.sections}
        />
        {snapshot.realtime !== undefined && (
          <RecentActivityCard
            count={snapshot.realtime}
            locations={snapshot.realtimeLocations}
            unavailable={activityUnavailable}
          />
        )}
        <PublicListCard
          title="Devices"
          tabs={deviceTabs}
          sections={snapshot.sections}
        />
        <PublicListCard
          title="Locations"
          tabs={locationTabs}
          sections={snapshot.sections}
        />
        {snapshot.sections.events !== undefined && (
          <LayerCard
            role="region"
            aria-label="Custom events"
            className="sm:col-span-2"
          >
            <LayerCard.Secondary>Custom events</LayerCard.Secondary>
            <LayerCard.Primary className="h-full p-2.5">
              <RankedList
                items={snapshot.sections.events.rows.map((row, index) => ({
                  key: `${index}:${row.label}`,
                  label: row.label,
                  value: row.count,
                }))}
                metricLabel="Events"
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
