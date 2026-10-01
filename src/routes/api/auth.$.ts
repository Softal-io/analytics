import { createFileRoute } from "@tanstack/react-router"
import { getAuth, isGoogleConfigured } from "@/lib/auth"

function handle(request: Request) {
  if (
    new URL(request.url).pathname === "/api/auth/sign-in/social" &&
    !isGoogleConfigured()
  ) {
    return Response.json(
      { message: "Google sign-in has not been configured yet." },
      { status: 503 }
    )
  }
  return getAuth().handler(request)
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
})
