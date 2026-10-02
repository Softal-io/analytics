import { Button } from "@cloudflare/kumo/components/button"
import { Dialog } from "@cloudflare/kumo/components/dialog"
import { Input } from "@cloudflare/kumo/components/input"
import { CheckIcon, CopyIcon } from "@phosphor-icons/react"
import { useEffect, useState } from "react"
import { z } from "zod"
import type { PublicViewSettings } from "@/lib/public-options"
import {
  canShareRealtimeGlobe,
  metricLabels,
  publicMetrics,
  publicSections,
  sectionLabels,
} from "@/lib/public-options"

export function PublicViewDialog({
  open,
  onOpenChange,
  siteId,
  siteName,
  trackerOrigin,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  siteId: string
  siteName: string
  trackerOrigin: string
}) {
  const [settings, setSettings] = useState<PublicViewSettings | null>(null)
  const [savedUrl, setSavedUrl] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setSettings(null)
    setSavedUrl(null)
    setError(null)
    setCopied(false)
    fetch(`/api/sites/${siteId}/public-view`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Could not load public sharing settings")
        const value = z
          .object({
            slug: z.string(),
            enabled: z.boolean(),
            metrics: z.array(z.enum(publicMetrics)),
            sections: z.array(z.enum(publicSections)),
          })
          .parse(await response.json())
        setSettings({
          slug: value.slug,
          enabled: value.enabled,
          metrics: value.metrics,
          sections: value.sections,
        })
        if (value.enabled) setSavedUrl(`${trackerOrigin}/public/${value.slug}`)
      })
      .catch((cause) => {
        if (cause.name !== "AbortError") setError(cause.message)
      })
    return () => controller.abort()
  }, [open, siteId, trackerOrigin])
  async function save(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      const response = await fetch(`/api/sites/${siteId}/public-view`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      })
      const body: unknown = await response.json()
      if (!response.ok)
        throw new Error(
          z.object({ error: z.string().optional() }).parse(body).error ??
            "Could not save public view"
        )
      const result = z
        .object({ enabled: z.boolean(), publicUrl: z.string() })
        .parse(body)
      setSavedUrl(result.enabled ? result.publicUrl : null)
      setCopied(false)
      if (!result.enabled) onOpenChange(false)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save public view"
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="w-[calc(100vw-32px)] max-w-xl min-w-0 bg-kumo-base p-0 sm:w-xl">
        <form
          onSubmit={save}
          className="flex max-h-[calc(100svh-32px)] flex-col"
        >
          <header className="space-y-1 border-b border-kumo-line p-4">
            <Dialog.Title className="text-lg font-semibold">
              Public view for {siteName}
            </Dialog.Title>
            <Dialog.Description className="text-sm text-kumo-subtle">
              Choose what anyone with the link can see. Only the checked items
              will be shared.
            </Dialog.Description>
          </header>
          <div className="space-y-5 overflow-y-auto p-4">
            {settings && (
              <>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={settings.enabled}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        enabled: event.target.checked,
                      })
                    }
                  />
                  Enable public view
                </label>
                <Input
                  label="Public URL name"
                  value={settings.slug}
                  onChange={(event) =>
                    setSettings({ ...settings, slug: event.target.value })
                  }
                  required
                  minLength={3}
                  maxLength={80}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  description={`${trackerOrigin}/public/${settings.slug}`}
                />
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm font-medium">
                    Overview metrics
                  </legend>
                  <div className="grid grid-cols-2 gap-3">
                    {publicMetrics.map((metric) => (
                      <label
                        key={metric}
                        className="flex items-center gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={settings.metrics.includes(metric)}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              metrics: event.target.checked
                                ? [...settings.metrics, metric]
                                : settings.metrics.filter(
                                    (value) => value !== metric
                                  ),
                            })
                          }
                        />
                        {metricLabels[metric]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm font-medium">
                    Dashboard sections
                  </legend>
                  <div className="grid grid-cols-2 gap-3">
                    {publicSections.map((section) => (
                      <label
                        key={section}
                        className="flex items-center gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={settings.sections.includes(section)}
                          disabled={
                            section === "realtimeGlobe" &&
                            !canShareRealtimeGlobe(settings.sections)
                          }
                          onChange={(event) => {
                            const sections = event.target.checked
                              ? [...settings.sections, section]
                              : settings.sections.filter(
                                  (value) => value !== section
                                )
                            setSettings({
                              ...settings,
                              sections: canShareRealtimeGlobe(sections)
                                ? sections
                                : sections.filter(
                                    (value) => value !== "realtimeGlobe"
                                  ),
                            })
                          }}
                        />
                        {sectionLabels[section]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <p className="text-xs text-kumo-subtle">
                  The traffic chart includes visitors and pageviews. Location
                  sections share their selected granularity. The live location
                  globe shares approximate city-level locations and requires
                  Cities and Live visitor count. It is shared only when its
                  checkbox is selected. Public views always include the website
                  name and domain.
                </p>
              </>
            )}
            {savedUrl && (
              <div className="flex flex-col gap-3 rounded-lg bg-kumo-tint p-3">
                <p className="text-sm font-medium">Saved public link</p>
                <a
                  className="text-sm leading-relaxed break-all underline decoration-kumo-line underline-offset-4 hover:decoration-current"
                  href={savedUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {savedUrl}
                </a>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="self-end"
                  icon={copied ? <CheckIcon /> : <CopyIcon />}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(savedUrl)
                      setCopied(true)
                    } catch {
                      setError(
                        "Could not copy the link. You can select it above."
                      )
                    }
                  }}
                >
                  {copied ? "Copied" : "Copy link"}
                </Button>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-kumo-danger">
                {error}
              </p>
            )}
          </div>
          <footer className="flex justify-end gap-2 border-t border-kumo-line p-4">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!settings || pending}
              loading={pending}
            >
              Save public view
            </Button>
          </footer>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
