import { useCallback, useEffect, useState } from "react"

/** Data is usable only for the exact URL that produced it. */
export function useAnalyticsData<T>(url?: string) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    url?: string
    data?: T
    error?: string
    loading: boolean
  }>({ loading: false })
  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    let cancelled = false
    setState({ url, loading: true })
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Could not load analytics. Please try again.")
        const data = (await response.json()) as T
        if (!cancelled) setState({ url, data, loading: false })
      })
      .catch(() => {
        if (!cancelled)
          setState({
            url,
            error: "Could not load analytics. Please try again.",
            loading: false,
          })
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [url, attempt])
  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  return {
    ...(url && state.url === url ? state : { loading: Boolean(url) }),
    retry,
  }
}
