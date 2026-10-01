import { Badge } from "@cloudflare/kumo/components/badge"
import { Button } from "@cloudflare/kumo/components/button"
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown"
import { CaretDownIcon } from "@phosphor-icons/react"
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { useEffect, useState } from "react"
import { z } from "zod"
import { PublicDashboard } from "@/components/dashboard/public-dashboard"
import { SourceIcon } from "@/components/dashboard/icons"

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
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <SourceIcon domain={snapshot.site.domain} />
          <h1
            className="max-w-52 shrink-0 font-semibold"
            title={snapshot.site.domain}
          >
            {snapshot.site.name}
          </h1>
          {live !== undefined && live > 0 && (
            <Badge appearance="dot" variant="success">
              {live} online
            </Badge>
          )}
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
      <PublicDashboard snapshot={snapshot} />
      <p className="text-center text-xs text-kumo-subtle">
        {snapshot.range.fromDate} to {snapshot.range.toDate} · Shared by the
        website owner
      </p>
    </main>
  )
}
