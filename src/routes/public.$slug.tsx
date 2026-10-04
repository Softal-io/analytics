import { Button } from "@cloudflare/kumo/components/button"
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown"
import { CaretDownIcon } from "@phosphor-icons/react"
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { PublicDashboard } from "@/components/dashboard/public-dashboard"
import { SourceIcon } from "@/components/dashboard/icons"
import { usePublicRealtime } from "@/hooks/use-public-realtime"

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

function PublicView() {
  const snapshot = Route.useLoaderData()
  const { slug } = Route.useParams()
  const { range = "30d" } = Route.useSearch()
  const navigate = useNavigate()
  const live = usePublicRealtime(
    slug,
    snapshot.realtime,
    snapshot.realtimeLocations
  )
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-full items-center gap-2 sm:basis-0">
          <SourceIcon domain={snapshot.site.domain} />
          <h1
            className="min-w-0 truncate font-semibold"
            title={snapshot.site.domain}
          >
            {snapshot.site.name}
          </h1>
        </div>
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <Button
                variant="ghost"
                className="shrink-0"
                aria-label="Select date range"
              >
                {rangeLabels[ranges.indexOf(range)]}
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
            {ranges.map((value, index) => (
              <DropdownMenu.Item
                key={value}
                selected={range === value}
                className="[&>span:last-child]:ml-auto"
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
      {live.unavailable && (
        <p role="status" className="text-xs text-kumo-subtle">
          Live updates temporarily unavailable. Retrying…
        </p>
      )}
      <PublicDashboard
        activityUnavailable={live.unavailable}
        snapshot={{
          ...snapshot,
          realtime: live.count,
          realtimeLocations: live.locations,
        }}
      />
      <p className="text-center text-xs text-kumo-subtle">
        {snapshot.range.fromDate} to {snapshot.range.toDate} · Shared by the
        website owner
      </p>
    </main>
  )
}
