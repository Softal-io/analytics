import { Badge } from "@cloudflare/kumo/components/badge"
import { Button } from "@cloudflare/kumo/components/button"
import { Empty } from "@cloudflare/kumo/components/empty"
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import {
  CaretDownIcon,
  CodeIcon,
  ShareNetworkIcon,
  TrashIcon,
  UserCircleIcon,
} from "@phosphor-icons/react"
import { ChartBarIcon } from "@phosphor-icons/react/dist/ssr"
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import type {
  DeviceDimension,
  LocationDimension,
  PageDimension,
  SourceDimension,
  TopDeviceRow,
  TopEventRow,
  TopLocationRow,
  TopPageRow,
  TopSourceRow,
} from "@/lib/top-lists"
import { AddSiteDialog } from "@/components/dashboard/add-site-dialog"
import { DeleteSiteDialog } from "@/components/dashboard/delete-site-dialog"
import { CountryFlag, SourceIcon } from "@/components/dashboard/icons"
import { InstallScriptDialog } from "@/components/dashboard/install-script-dialog"
import { PublicViewDialog } from "@/components/dashboard/public-view-dialog"
import { authClient } from "@/lib/auth-client"
import { CardHeader } from "@/components/dashboard/card-header"
import {
  BrowserMark,
  DeviceMark,
  OsMark,
} from "@/components/dashboard/device-icons"
import { OverviewCard } from "@/components/dashboard/overview-card"
import { RankedList } from "@/components/dashboard/ranked-list"
import { RecentActivityCard } from "@/components/dashboard/recent-activity-card"
import { useAnalyticsData } from "@/hooks/use-analytics-data"
import { useLiveVisitors } from "@/hooks/use-live-visitors"
import { useSourceDetails } from "@/hooks/use-source-details"
import { externalUrl, pageUrl } from "@/lib/dashboard-links"
import {
  SourceDetailsContent,
  sourceHref,
} from "@/components/dashboard/source-details"

/** Server function — the dashboard's own UI reads its initial data this way. */
const getDashboardData = createServerFn().handler(async () => {
  const { loadDashboardData } = await import("@/lib/dashboard-data")
  return await loadDashboardData()
})

type UiRangeKey = "today" | "7d" | "30d" | "6m" | "1y"

const RANGE_OPTIONS: Array<{ value: UiRangeKey; label: string }> = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "6m", label: "Last 6 months" },
  { value: "1y", label: "Last 12 months" },
]

const searchSchema = z.object({
  site: z.string().optional(),
  range: z.enum(["today", "7d", "30d", "6m", "1y"]).optional(),
  simulateLocations: z
    .union([
      z.boolean(),
      z.enum(["true", "false"]).transform((value) => value === "true"),
    ])
    .optional(),
})

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  loader: () => getDashboardData(),
  component: App,
})

interface SummaryResponse {
  visitors: number
  visits: number
  pageviews: number
  bounceRate: number
  avgDurationSeconds: number
}

interface TimeseriesPoint {
  timestamp: number
  pageviews: number
  visitors: number
}

interface TopListResponse<TRow> {
  rows: Array<TRow>
  total: number
  animateItems: boolean
  loading: boolean
  error?: string
  retry: () => void
}

function useTopList<TRow>(
  siteId: string | undefined,
  range: UiRangeKey,
  resource: "pages" | "sources" | "devices" | "locations",
  view: string,
  animateViewChange: boolean
): TopListResponse<TRow> {
  const request = useAnalyticsData<{ rows: Array<TRow>; total: number }>(
    siteId
      ? `/api/sites/${siteId}/${resource}?range=${range}&view=${view}`
      : undefined
  )
  const resolvedViewRef = useRef<string | null>(null)
  const animateItems = Boolean(
    request.data &&
    animateViewChange &&
    resolvedViewRef.current !== null &&
    resolvedViewRef.current !== view
  )
  useEffect(() => {
    if (request.data) resolvedViewRef.current = view
  }, [request.data, view])
  return {
    rows: request.data?.rows ?? [],
    total: request.data?.total ?? 0,
    animateItems,
    loading: request.loading,
    error: request.error,
    retry: request.retry,
  }
}

const countryNames = new Intl.DisplayNames(["en"], { type: "region" })

function locationLabel(row: TopLocationRow, dimension: LocationDimension) {
  const country = countryNames.of(row.country) ?? row.country
  if (dimension === "city") return `${row.city}, ${country}`
  if (dimension === "region") return `${row.region}, ${country}`
  return country
}

function AccountMenu({ email, isAdmin }: { email: string; isAdmin: boolean }) {
  const navigate = useNavigate()
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            variant="ghost"
            icon={<UserCircleIcon size={20} />}
            aria-label="Account menu"
          />
        }
      />
      <DropdownMenu.Content
        align="end"
        className="t-dropdown t-dropdown-origin-top-right w-72 max-w-[calc(100vw-32px)] p-0"
      >
        <div className="space-y-2 px-3.5 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-kumo-subtle">Signed in as</p>
            <Badge variant={isAdmin ? "primary" : "secondary"}>
              {isAdmin ? "Admin" : "Viewer"}
            </Badge>
          </div>
          <p className="text-sm font-medium break-all">{email}</p>
        </div>
        <DropdownMenu.Separator className="mx-0 my-0" />
        <DropdownMenu.Group className="p-1.5">
          {isAdmin && (
            <DropdownMenu.Item onClick={() => navigate({ to: "/admin/users" })}>
              Manage user access
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item
            onClick={async () => {
              await authClient.signOut()
              window.location.assign("/login")
            }}
          >
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

function App() {
  const { sites: allSites, trackerOrigin, user } = Route.useLoaderData()
  const isAdmin = user.role === "admin"
  const search = Route.useSearch()
  const navigate = useNavigate()
  const router = useRouter()

  const selectedSiteId =
    search.site && allSites.some((s) => s.id === search.site)
      ? search.site
      : allSites[0]?.id
  const range = search.range ?? "30d"

  const base = selectedSiteId ? `/api/sites/${selectedSiteId}` : undefined
  const summaryRequest = useAnalyticsData<SummaryResponse>(
    base ? `${base}/summary?range=${range}` : undefined
  )
  const pointsRequest = useAnalyticsData<{ points: Array<TimeseriesPoint> }>(
    base ? `${base}/timeseries?range=${range}` : undefined
  )
  const eventsRequest = useAnalyticsData<{
    rows: Array<TopEventRow>
    total: number
  }>(base ? `${base}/activity?range=${range}` : undefined)
  const summary = summaryRequest.data
  const points = pointsRequest.data?.points ?? []
  const eventRows = eventsRequest.data?.rows ?? []
  const eventTotal = eventsRequest.data?.total ?? 0
  const loading = summaryRequest.loading || pointsRequest.loading
  const [pageDimension, setPageDimension] = useState<PageDimension>("top")
  const [sourceDimension, setSourceDimension] =
    useState<SourceDimension>("referrer")
  const [deviceDimension, setDeviceDimension] =
    useState<DeviceDimension>("browser")
  const [locationDimension, setLocationDimension] =
    useState<LocationDimension>("country")
  const [addSiteOpen, setAddSiteOpen] = useState(false)
  const [deleteSiteId, setDeleteSiteId] = useState<string | null>(null)
  const [installSiteId, setInstallSiteId] = useState<string | null>(null)
  const [publicViewOpen, setPublicViewOpen] = useState(false)
  const animatePageFilterRef = useRef(false)
  const animateSourceFilterRef = useRef(false)
  const animateDeviceFilterRef = useRef(false)
  const animateLocationFilterRef = useRef(false)

  const liveVisitors = useLiveVisitors(selectedSiteId)
  const sourceDetails = useSourceDetails(
    base ? `${base}/source-details?range=${range}` : undefined
  )
  const pageList = useTopList<TopPageRow>(
    selectedSiteId,
    range,
    "pages",
    pageDimension,
    animatePageFilterRef.current
  )
  const sourceList = useTopList<TopSourceRow>(
    selectedSiteId,
    range,
    "sources",
    sourceDimension,
    animateSourceFilterRef.current
  )
  const outboundList = useTopList<TopSourceRow>(
    selectedSiteId,
    range,
    "sources",
    "links",
    false
  )
  const deviceList = useTopList<TopDeviceRow>(
    selectedSiteId,
    range,
    "devices",
    deviceDimension,
    animateDeviceFilterRef.current
  )
  const locationList = useTopList<TopLocationRow>(
    selectedSiteId,
    range,
    "locations",
    locationDimension,
    animateLocationFilterRef.current
  )

  function selectSite(id: string) {
    navigate({ to: "/", search: (prev) => ({ ...prev, site: id }) })
  }
  function selectRange(value: UiRangeKey) {
    navigate({ to: "/", search: (prev) => ({ ...prev, range: value }) })
  }
  async function handleSiteCreated(id: string) {
    await router.invalidate()
    selectSite(id)
    setInstallSiteId(id)
  }

  async function handleSiteDeleted(id: string) {
    const nextSite = allSites.find((site) => site.id !== id)
    setDeleteSiteId(null)
    await router.invalidate()
    navigate({
      to: "/",
      search: (prev) => ({ ...prev, site: nextSite?.id }),
      replace: true,
    })
  }

  if (allSites.length === 0) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
        <AccountMenu email={user.email} isAdmin={isAdmin} />
        <Empty
          icon={<ChartBarIcon weight="duotone" size={32} />}
          title={isAdmin ? "Add a site to start tracking" : "No websites yet"}
          contents={
            isAdmin ? (
              <AddSiteDialog onCreated={handleSiteCreated} />
            ) : (
              <p>An admin can add a website.</p>
            )
          }
          className="max-w-sm [h2]:text-sm"
        />
      </div>
    )
  }

  const selectedSite =
    allSites.find((s) => s.id === selectedSiteId) ?? allSites[0]
  const installSite =
    allSites.find((site) => site.id === installSiteId) ?? selectedSite
  const deleteSite =
    allSites.find((site) => site.id === deleteSiteId) ?? selectedSite
  const rangeLabel =
    RANGE_OPTIONS.find((option) => option.value === range)?.label ?? range

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-full items-center gap-2 sm:basis-0">
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button
                  variant="ghost"
                  className="-ml-2 max-w-full min-w-0 shrink justify-start px-2"
                  aria-label={`Switch site. Current site: ${selectedSite.name}`}
                >
                  <SourceIcon domain={selectedSite.domain} />
                  <span className="min-w-0 truncate font-semibold">
                    {selectedSite.name}
                  </span>
                  <CaretDownIcon
                    className="size-4 shrink-0 text-neutral-500"
                    weight="bold"
                  />
                </Button>
              }
            />
            <DropdownMenu.Content align="start" className="t-dropdown min-w-56">
              {allSites.map((site) => (
                <DropdownMenu.Item
                  key={site.id}
                  icon={<SourceIcon domain={site.domain} />}
                  selected={site.id === selectedSiteId}
                  className="gap-2 [&>span:last-child]:ml-auto"
                  onClick={() => selectSite(site.id)}
                >
                  {site.name}
                </DropdownMenu.Item>
              ))}
              {isAdmin && (
                <>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item onClick={() => setAddSiteOpen(true)}>
                    Add site
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    variant="danger"
                    icon={<TrashIcon />}
                    onClick={() => setDeleteSiteId(selectedSite.id)}
                  >
                    Delete site
                  </DropdownMenu.Item>
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {isAdmin && (
            <>
              <Button
                variant="ghost"
                icon={<CodeIcon weight="bold" className="text-neutral-800" />}
                onClick={() => setInstallSiteId(selectedSite.id)}
                aria-label="Install script"
              />
              <Button
                variant="ghost"
                icon={<ShareNetworkIcon weight="bold" />}
                aria-label="Public sharing"
                onClick={() => setPublicViewOpen(true)}
              />
            </>
          )}
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button variant="ghost" aria-label="Select date range">
                  {rangeLabel}
                  <CaretDownIcon
                    className="size-4 text-neutral-500"
                    weight="bold"
                  />
                </Button>
              }
            />
            <DropdownMenu.Content
              align="end"
              className="t-dropdown t-dropdown-origin-top-right min-w-44"
            >
              {RANGE_OPTIONS.map((option) => (
                <DropdownMenu.Item
                  key={option.value}
                  selected={option.value === range}
                  className="[&>span:last-child]:ml-auto"
                  onClick={() => selectRange(option.value)}
                >
                  {option.label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu>
          <AccountMenu email={user.email} isAdmin={isAdmin} />
        </div>
      </header>

      {isAdmin && (
        <>
          <PublicViewDialog
            open={publicViewOpen}
            onOpenChange={setPublicViewOpen}
            siteId={selectedSite.id}
            siteName={selectedSite.name}
            trackerOrigin={trackerOrigin}
          />
          <AddSiteDialog
            open={addSiteOpen}
            onOpenChange={setAddSiteOpen}
            showTrigger={false}
            onCreated={handleSiteCreated}
          />
          <InstallScriptDialog
            open={installSiteId !== null}
            onOpenChange={(open) => !open && setInstallSiteId(null)}
            siteId={installSite.id}
            siteName={installSite.name}
            trackerOrigin={trackerOrigin}
          />
          <DeleteSiteDialog
            open={deleteSiteId !== null}
            onOpenChange={(open) => !open && setDeleteSiteId(null)}
            siteId={deleteSite.id}
            siteName={deleteSite.name}
            onDeleted={handleSiteDeleted}
          />
        </>
      )}

      {(summaryRequest.error || pointsRequest.error) && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 text-sm text-kumo-subtle"
        >
          <span>
            Could not load the overview for this website and date range.
          </span>
          <Button
            variant="ghost"
            onClick={() => {
              summaryRequest.retry()
              pointsRequest.retry()
            }}
          >
            Try again
          </Button>
        </div>
      )}
      <OverviewCard
        timezone={selectedSite.timezone}
        summary={summary ?? {}}
        metrics={summaryRequest.error ? [] : undefined}
        points={points}
        loading={loading && points.length === 0}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <LayerCard role="region" aria-label="Pages">
          <LayerCard.Secondary>
            <CardHeader
              title="Pages"
              tabs={[
                { value: "top", label: "Top" },
                { value: "entered", label: "Entered" },
                { value: "exited", label: "Exited" },
              ]}
              value={pageDimension}
              onValueChange={(value, animate) => {
                animatePageFilterRef.current = animate
                setPageDimension(value as PageDimension)
              }}
            />
          </LayerCard.Secondary>
          <LayerCard.Primary className="h-full p-2.5">
            <RankedList
              loading={pageList.loading}
              error={pageList.error}
              onRetry={pageList.retry}
              items={pageList.rows.map((r) => ({
                key: r.path,
                label: r.path,
                href: pageUrl(selectedSite.domain, r.path),
                value: r.count,
              }))}
              metricLabel={pageDimension === "top" ? "Pageviews" : "Visits"}
              total={pageList.total}
              animateItems={pageList.animateItems}
            />
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard role="region" aria-label="Outbound links">
          <LayerCard.Secondary>Outbound links</LayerCard.Secondary>
          <LayerCard.Primary className="h-full p-2.5">
            <RankedList
              loading={outboundList.loading}
              error={outboundList.error}
              onRetry={outboundList.retry}
              items={outboundList.rows.map((r) => ({
                key: r.key,
                label: r.label,
                href: externalUrl(r.key),
                icon: r.referrerDomain ? (
                  <SourceIcon domain={r.referrerDomain} />
                ) : undefined,
                value: r.visits,
              }))}
              metricLabel="Clicks"
              total={outboundList.total}
              emptyLabel="No outbound link clicks yet"
            />
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard role="region" aria-label="Sources">
          <LayerCard.Secondary>
            <CardHeader
              title="Sources"
              tabs={[
                { value: "referrer", label: "Referrers" },
                { value: "utm", label: "Campaigns" },
              ]}
              value={sourceDimension}
              onValueChange={(value, animate) => {
                animateSourceFilterRef.current = animate
                setSourceDimension(value as SourceDimension)
              }}
            />
          </LayerCard.Secondary>
          <LayerCard.Primary className="h-full p-2.5">
            <RankedList
              loading={sourceList.loading}
              error={sourceList.error}
              onRetry={sourceList.retry}
              items={sourceList.rows.map((r) => {
                const view = sourceDimension === "utm" ? "utm" : "referrer"
                const loaded = r.details
                  ? sourceDetails.get(r.key, view, r.details)
                  : undefined
                const details = loaded?.details ?? r.details
                return {
                  key: r.key,
                  label: r.label,
                  href: sourceHref(details, r.referrerDomain),
                  onDetailsOpen: r.details
                    ? () => {
                        void sourceDetails.load(r.key, view)
                      }
                    : undefined,
                  details: details ? (
                    <SourceDetailsContent
                      details={details}
                      loading={loaded?.loading}
                      error={loaded?.error}
                      retry={loaded?.retry}
                    />
                  ) : undefined,
                  icon: r.referrerDomain ? (
                    <SourceIcon domain={r.referrerDomain} />
                  ) : undefined,
                  value: r.visits,
                }
              })}
              metricLabel="Visits"
              total={sourceList.total}
              animateItems={sourceList.animateItems}
              emptyLabel={
                sourceDimension === "links"
                  ? "No outbound link clicks yet"
                  : sourceDimension === "utm"
                    ? "No UTM traffic yet"
                    : "No referrers yet"
              }
            />
          </LayerCard.Primary>
        </LayerCard>

        <RecentActivityCard
          unavailable={liveVisitors.unavailable}
          count={liveVisitors.count}
          locations={liveVisitors.locations}
          simulate={import.meta.env.DEV && search.simulateLocations === true}
        />

        <LayerCard role="region" aria-label="Devices">
          <LayerCard.Secondary>
            <CardHeader
              title="Devices"
              tabs={[
                { value: "browser", label: "Browsers" },
                { value: "os", label: "OS" },
                { value: "device", label: "Devices" },
              ]}
              value={deviceDimension}
              onValueChange={(value, animate) => {
                animateDeviceFilterRef.current = animate
                setDeviceDimension(value as DeviceDimension)
              }}
            />
          </LayerCard.Secondary>
          <LayerCard.Primary className="h-full p-2.5">
            <RankedList
              loading={deviceList.loading}
              error={deviceList.error}
              onRetry={deviceList.retry}
              items={deviceList.rows.map((r) => ({
                key: r.value,
                label:
                  deviceDimension === "device"
                    ? `${r.value.charAt(0).toUpperCase()}${r.value.slice(1)}`
                    : r.value,
                icon:
                  deviceDimension === "browser" ? (
                    <BrowserMark browser={r.value} />
                  ) : deviceDimension === "os" ? (
                    <OsMark os={r.value} />
                  ) : (
                    <DeviceMark device={r.value} />
                  ),
                value: r.visits,
              }))}
              metricLabel="Visits"
              total={deviceList.total}
              animateItems={deviceList.animateItems}
            />
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard role="region" aria-label="Locations">
          <LayerCard.Secondary>
            <CardHeader
              title="Locations"
              tabs={[
                { value: "country", label: "Countries" },
                { value: "region", label: "Regions" },
                { value: "city", label: "Cities" },
              ]}
              value={locationDimension}
              onValueChange={(value, animate) => {
                animateLocationFilterRef.current = animate
                setLocationDimension(value as LocationDimension)
              }}
            />
          </LayerCard.Secondary>
          <LayerCard.Primary className="h-full p-2.5">
            <RankedList
              loading={locationList.loading}
              error={locationList.error}
              onRetry={locationList.retry}
              items={locationList.rows.map((r) => ({
                key: `${r.country}-${r.region}-${r.city}`,
                label: locationLabel(r, locationDimension),
                icon: <CountryFlag country={r.country} />,
                value: r.visits,
              }))}
              metricLabel="Visits"
              total={locationList.total}
              animateItems={locationList.animateItems}
              emptyLabel={
                locationDimension === "region"
                  ? "No region data yet"
                  : locationDimension === "city"
                    ? "No city data yet"
                    : "No country data yet"
              }
            />
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard
          role="region"
          aria-label="Custom events"
          className="sm:col-span-2"
        >
          <LayerCard.Secondary>Custom events</LayerCard.Secondary>
          <LayerCard.Primary className="h-full p-2.5">
            <RankedList
              loading={eventsRequest.loading}
              error={eventsRequest.error}
              onRetry={eventsRequest.retry}
              items={eventRows.map((r) => ({
                key: r.name,
                label: r.name,
                value: r.count,
              }))}
              metricLabel="Events"
              total={eventTotal}
              emptyLabel="No custom events yet"
            />
          </LayerCard.Primary>
        </LayerCard>
      </div>
    </div>
  )
}
