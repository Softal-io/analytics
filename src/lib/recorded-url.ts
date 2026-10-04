import {
  MAX_RECORDED_PATH_CHARS,
  MAX_RECORDED_URL_CHARS,
  OMITTED_PAGE_PATH,
} from "./analytics-config"
import { externalUrl } from "./dashboard-links"

/** Never store a shortened URL that could navigate to a different destination. */
export function recordedUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_RECORDED_URL_CHARS)
    return undefined
  const href = externalUrl(value)
  return href && href.length <= MAX_RECORDED_URL_CHARS ? href : undefined
}

/** Preserve attribution when the complete referring URL is too long to record. */
export function boundedReferrer(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= MAX_RECORDED_URL_CHARS)
    return value
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length <= MAX_RECORDED_URL_CHARS
      ? url.hostname
      : undefined
  } catch {
    return undefined
  }
}

/** Keep counts for oversized page dimensions without inventing a partial link. */
export function boundedPagePath(value: unknown): unknown {
  return typeof value === "string" && value.length > MAX_RECORDED_PATH_CHARS
    ? OMITTED_PAGE_PATH
    : value
}
