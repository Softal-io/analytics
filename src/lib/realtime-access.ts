import { env } from "cloudflare:workers"

export const REALTIME_SESSION_HEADER = "X-Analytics-Session-ID"

/** Recheck current permissions and session expiry without storing cookie credentials. */
export async function authorizedRealtimeSessions(sessionIds: Array<string>) {
  const unique = [...new Set(sessionIds)]
  const authorized = new Set<string>()
  // Leave one of D1's 100 bound parameters for the current timestamp.
  for (let index = 0; index < unique.length; index += 99) {
    const batch = unique.slice(index, index + 99)
    const result = await env.DB.prepare(
      `
      SELECT session.id FROM auth_session AS session
      JOIN auth_user AS user ON user.id = session.user_id
      JOIN access_grants AS grant ON grant.email = lower(user.email)
      WHERE session.id IN (${batch.map(() => "?").join(",")})
        AND session.expires_at > ? AND user.email_verified = 1
        AND grant.role IN ('admin', 'viewer')
    `
    )
      .bind(...batch, Date.now())
      .all<{ id: string }>()
    for (const row of result.results) authorized.add(row.id)
  }
  return authorized
}
