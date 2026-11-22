/** The place a live visitor's location belongs to, in dashboard filter terms. */
export interface RealtimeVisitorPlace {
  country: string
  region: string | null
  city: string | null
}

export interface RealtimeVisitorLocation {
  latitude: number
  longitude: number
  count: number
  /** Absent when the place is unknown, and on public dashboards. */
  place?: RealtimeVisitorPlace
}

export interface RealtimeVisitorsPayload {
  count: number
  locations: Array<RealtimeVisitorLocation>
}
