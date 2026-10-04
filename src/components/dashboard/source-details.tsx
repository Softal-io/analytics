import { ArrowSquareOutIcon } from "@phosphor-icons/react"
import type { SourceDetails } from "@/lib/source-details"
import { externalUrl, referrerUrl } from "@/lib/dashboard-links"
import { SOURCE_URLS_PER_KIND } from "@/lib/analytics-config"

export function sourceHref(details?: SourceDetails, domain?: string) {
  const link =
    details?.links.find((item) => item.kind === "referrer") ?? details?.links[0]
  return externalUrl(link?.url) ?? (domain ? referrerUrl(domain) : undefined)
}

export function SourceDetailsContent({
  details,
  loading,
  error,
  retry,
}: {
  details: SourceDetails
  loading?: boolean
  error?: string
  retry?: () => void
}) {
  const campaign = details.utmSource !== undefined
  return (
    <div className="max-h-[min(60vh,24rem)] w-80 max-w-[calc(100vw-48px)] space-y-3 overflow-y-auto px-1 py-1 text-xs text-kumo-default">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {campaign ? (
          [
            ["Source", details.utmSource],
            ["Medium", details.utmMedium],
            ["Campaign", details.utmCampaign],
          ].map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-kumo-subtle">{label}</dt>
              <dd className="break-words">{value || "Not set"}</dd>
            </div>
          ))
        ) : (
          <>
            <dt className="text-kumo-subtle">Referrer</dt>
            <dd className="break-words">
              {details.referrerDomain === "(direct)"
                ? "Direct"
                : details.referrerDomain === "(unknown)"
                  ? "Unknown"
                  : details.referrerDomain}
            </dd>
          </>
        )}
      </dl>
      {loading && (
        <p role="status" className="text-kumo-subtle">
          Loading URL details…
        </p>
      )}
      {error && (
        <p role="status" className="text-kumo-subtle">
          {error}{" "}
          <button type="button" onClick={retry} className="underline">
            Try again
          </button>
        </p>
      )}
      {!loading &&
        !error &&
        (["referrer", "landing"] as const).map((kind) => {
          const links = details.links.filter((link) => link.kind === kind)
          return links.length ? (
            <div key={kind} className="space-y-1.5">
              <p className="font-medium">
                {kind === "referrer"
                  ? "Referring URLs (browser supplied)"
                  : "Tagged landing URLs"}
              </p>
              {links.map((link) => (
                <div key={link.url} className="flex items-start gap-2">
                  <a
                    href={externalUrl(link.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 flex-1 break-all text-kumo-link underline decoration-kumo-line underline-offset-2 hover:text-kumo-default"
                  >
                    {link.url}{" "}
                    <ArrowSquareOutIcon
                      className="inline"
                      size={12}
                      aria-hidden="true"
                    />
                  </a>
                  <span className="shrink-0 text-kumo-subtle">
                    {link.visits.toLocaleString()}{" "}
                    {link.visits === 1 ? "visit" : "visits"}
                  </span>
                </div>
              ))}
            </div>
          ) : null
        })}
      {!loading &&
        !error &&
        !details.links.some((link) => link.kind === "referrer") && (
          <p className="text-kumo-subtle">
            No referring URL was recorded. Browsers may hide the URL or provide
            only its origin. URLs exceeding the recording limit are omitted.
          </p>
        )}
      {details.hasMore ? (
        <p className="text-kumo-subtle">
          Showing the {SOURCE_URLS_PER_KIND} most visited URLs per group.
        </p>
      ) : (
        details.linkCount > details.links.length && (
          <p className="text-kumo-subtle">
            Showing the most common {details.links.length} of{" "}
            {details.linkCount} recorded URLs.
          </p>
        )
      )}
      {details.updatedAt && (
        <p className="text-kumo-subtle">
          URLs updated at{" "}
          {new Date(details.updatedAt * 1000).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      )}
    </div>
  )
}
