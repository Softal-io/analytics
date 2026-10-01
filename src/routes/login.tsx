import { Button } from "@cloudflare/kumo/components/button"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { ChartBarIcon } from "@phosphor-icons/react"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { useState } from "react"
import { authClient } from "@/lib/auth-client"

const getLoginState = createServerFn().handler(async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server")
  const { getPrincipal } = await import("@/lib/access")
  const { isGoogleConfigured } = await import("@/lib/auth")
  const configured = isGoogleConfigured()
  const user = configured ? await getPrincipal(getRequestHeaders()) : null
  if (user?.role) throw redirect({ to: "/" })
  return { configured, user }
})

export const Route = createFileRoute("/login")({
  loader: () => getLoginState(),
  component: Login,
})

function Login() {
  const { configured, user } = Route.useLoaderData()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function signIn() {
    setPending(true)
    setError(null)
    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: "/",
      })
      if (result.error)
        throw new Error(result.error.message ?? "Could not sign in")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in")
      setPending(false)
    }
  }
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <LayerCard className="w-full max-w-sm">
        <LayerCard.Secondary>
          <span className="flex items-center gap-2">
            <ChartBarIcon size={20} />
            Web Analytics
          </span>
        </LayerCard.Secondary>
        <LayerCard.Primary className="space-y-5 p-6">
          <div className="space-y-2">
            <h1 className="text-xl font-semibold">
              {user ? "Awaiting access" : "Welcome back"}
            </h1>
            <p className="text-sm text-kumo-subtle">
              {user
                ? `You're signed in as ${user.email}. An admin needs to grant you access to private analytics.`
                : "Sign in to view your websites’ analytics."}
            </p>
          </div>
          {user ? (
            <Button
              variant="secondary"
              className="w-full"
              onClick={async () => {
                await authClient.signOut()
                window.location.assign("/login")
              }}
            >
              Sign out
            </Button>
          ) : (
            <Button
              variant="primary"
              className="w-full"
              loading={pending}
              disabled={!configured || pending}
              onClick={signIn}
            >
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
              >
                <path
                  fill="currentColor"
                  d="M21.6 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.2 3-7.4zM12 22c2.7 0 5-1 6.6-2.4l-3.2-2.5c-.9.6-2 .9-3.4.9-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22zM6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9l3.3-2.6zM12 6c1.5 0 2.8.5 3.8 1.5l2.8-2.8A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.9 5.5l3.3 2.6A6 6 0 0 1 12 6z"
                />
              </svg>
              Continue with Google
            </Button>
          )}
          {!configured && (
            <p className="text-sm text-kumo-subtle">
              Google sign-in is being configured. Please try again soon.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-kumo-danger">
              {error}
            </p>
          )}
        </LayerCard.Primary>
      </LayerCard>
    </main>
  )
}
