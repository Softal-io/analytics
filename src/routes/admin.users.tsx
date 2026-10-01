import { Button } from "@cloudflare/kumo/components/button"
import { Input } from "@cloudflare/kumo/components/input"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { Link, createFileRoute, useRouter } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { useState } from "react"
import { z } from "zod"

const getAccessList = createServerFn().handler(async () => {
  const { requireAdmin } = await import("@/lib/access")
  await requireAdmin()
  const { db } = await import("@/db")
  const { accessGrants, authUser } = await import("@/db/schema")
  const { asc, eq } = await import("drizzle-orm")
  return db
    .select({
      email: accessGrants.email,
      role: accessGrants.role,
      name: authUser.name,
      signedUp: authUser.createdAt,
    })
    .from(accessGrants)
    .leftJoin(authUser, eq(authUser.email, accessGrants.email))
    .orderBy(asc(accessGrants.email))
})

export const Route = createFileRoute("/admin/users")({
  loader: () => getAccessList(),
  component: Users,
})

function Users() {
  const users = Route.useLoaderData()
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [role, setRole] = useState("viewer")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function update(
    method: "PUT" | "DELETE",
    grantEmail: string,
    grantRole?: string
  ) {
    setPending(true)
    setError(null)
    try {
      const response = await fetch("/api/admin/access", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: grantEmail,
          ...(grantRole ? { role: grantRole } : {}),
        }),
      })
      if (!response.ok) {
        const body = z
          .object({ error: z.string().optional() })
          .parse(await response.json())
        throw new Error(body.error ?? "Could not update access")
      }
      await router.invalidate()
      if (method === "PUT") setEmail("")
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update access"
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <main className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">User access</h1>
        <Link to="/" className="text-sm underline">
          Back to analytics
        </Link>
      </header>
      <LayerCard>
        <LayerCard.Secondary>Grant access</LayerCard.Secondary>
        <LayerCard.Primary className="p-4">
          <p className="mb-4 text-sm text-kumo-subtle">
            Viewers can read private analytics. Admins can also manage websites,
            user access, and public sharing. Access works when the email signs
            in with Google.
          </p>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void update("PUT", email, role)
            }}
          >
            <Input
              label="Google email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
              required
            />
            <label className="grid gap-1 text-sm">
              Role
              <select
                aria-label="New user role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                className="h-9 rounded-md bg-kumo-base px-3 ring ring-kumo-line"
              >
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <Button
              type="submit"
              variant="primary"
              disabled={pending}
              loading={pending}
            >
              Grant access
            </Button>
          </form>
        </LayerCard.Primary>
      </LayerCard>
      {error && (
        <p role="alert" className="text-sm text-kumo-danger">
          {error}
        </p>
      )}
      <LayerCard>
        <LayerCard.Secondary>Approved emails</LayerCard.Secondary>
        <LayerCard.Primary className="divide-y divide-kumo-line p-4">
          {users.map((user) => (
            <div
              key={user.email}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium break-all">{user.email}</p>
                <p className="text-xs text-kumo-subtle">
                  {user.name ?? "Has not signed in yet"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  aria-label={`Role for ${user.email}`}
                  value={user.role}
                  disabled={pending}
                  onChange={(event) =>
                    void update("PUT", user.email, event.target.value)
                  }
                  className="rounded-md bg-kumo-base px-3 py-2 text-sm ring ring-kumo-line"
                >
                  <option value="viewer">Viewer</option>
                  <option value="admin">Admin</option>
                </select>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={() => void update("DELETE", user.email)}
                >
                  Revoke
                </Button>
              </div>
            </div>
          ))}
        </LayerCard.Primary>
      </LayerCard>
    </main>
  )
}
