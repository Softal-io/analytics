import { eq } from "drizzle-orm"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { redirect } from "@tanstack/react-router"
import { db } from "@/db"
import { accessGrants } from "@/db/schema"
import { getAuth } from "@/lib/auth"

export interface Principal {
  id: string
  name: string
  email: string
  role: "admin" | "viewer" | null
}

export async function getAccessSession(headers: Headers) {
  const session = await getAuth().api.getSession({ headers })
  if (!session?.user.emailVerified) return null
  const email = session.user.email.toLowerCase()
  const grant = await db
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.email, email))
    .get()
  const principal: Principal = {
    id: session.user.id,
    name: session.user.name,
    email,
    role: grant?.role ?? null,
  }
  return { principal, sessionId: session.session.id }
}

export async function getPrincipal(
  headers: Headers
): Promise<Principal | null> {
  return (await getAccessSession(headers))?.principal ?? null
}

export async function requireViewer() {
  const principal = await getPrincipal(getRequestHeaders())
  if (!principal?.role) throw redirect({ to: "/login" })
  return principal
}

export async function requireAdmin(request?: Request) {
  const principal = await getPrincipal(request?.headers ?? getRequestHeaders())
  if (principal?.role !== "admin")
    throw new Response("Admin access required", { status: 403 })
  return principal
}
