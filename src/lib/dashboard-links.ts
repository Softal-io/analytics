/** Only website URLs may become dashboard navigation links. */
export function externalUrl(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
    if (url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** Build a domain fallback when the original referring URL is unavailable. */
export function referrerUrl(domain: string): string | undefined {
  if (domain !== domain.trim() || /[\s/@?#\\]/.test(domain)) return undefined
  const href = externalUrl(`https://${domain}`)
  if (!href) return undefined
  const hostname = new URL(href).hostname
  return hostname.includes(".") || hostname === "localhost" ? href : undefined
}

export function pageUrl(domain: string, path: string): string | undefined {
  const site = externalUrl(domain) ?? referrerUrl(domain)
  if (!site || !path.startsWith("/")) return undefined
  try {
    const origin = new URL(site).origin
    const url = new URL(path, origin)
    return url.origin === origin ? url.href : undefined
  } catch {
    return undefined
  }
}
