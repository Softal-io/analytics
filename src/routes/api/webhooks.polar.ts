import { createFileRoute } from "@tanstack/react-router"
import { env } from "cloudflare:workers"
import { polarOrder, recordOrder, verifyWebhookSignature } from "@/lib/payments"

const MAX_WEBHOOK_BYTES = 256 * 1024

/**
 * `POST /api/webhooks/polar` receives order events from Polar. The request
 * is trusted only through its signature; there is no session.
 *
 * Orders reach a website through the `reference_id` the tracker adds to
 * checkout links. Add `?site=<site id>` to the endpoint URL to also record
 * orders without a reference (for example, purchases started outside the
 * website) against one website.
 */
export const Route = createFileRoute("/api/webhooks/polar")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secrets = (env.POLAR_WEBHOOK_SECRET ?? "")
          .split(/[\s,]+/)
          .filter(Boolean)
        if (!secrets.length)
          return Response.json(
            {
              error: "Set the POLAR_WEBHOOK_SECRET secret to accept webhooks.",
            },
            { status: 503 }
          )
        const declared = Number(request.headers.get("Content-Length") ?? 0)
        if (declared > MAX_WEBHOOK_BYTES)
          return new Response(null, { status: 413 })
        const body = await request.text()
        if (body.length > MAX_WEBHOOK_BYTES)
          return new Response(null, { status: 413 })
        const nowSec = Math.floor(Date.now() / 1000)
        if (
          !(await verifyWebhookSignature(
            body,
            request.headers,
            secrets,
            nowSec
          ))
        )
          return Response.json({ error: "Invalid signature" }, { status: 403 })

        let payload: unknown
        try {
          payload = JSON.parse(body)
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 })
        }
        // Other event types are acknowledged so Polar keeps the endpoint enabled.
        const order = polarOrder(payload, nowSec)
        if (!order) {
          // A paid order that cannot be read is a lost payment: leave a trace.
          const type = (payload as { type?: unknown } | null)?.type
          if (type === "order.paid" || type === "order.refunded")
            console.error("Polar order event has an unexpected shape", type)
          return Response.json({ status: "ignored" }, { status: 202 })
        }
        const fallbackSite = new URL(request.url).searchParams.get("site")
        try {
          const status = await recordOrder(order, fallbackSite ?? undefined)
          return Response.json({ status }, { status: 202 })
        } catch (error) {
          // A failure response makes Polar deliver the event again.
          console.error(
            "Payment webhook failed",
            error instanceof Error ? error.message : "Unknown error"
          )
          return Response.json({ error: "Try again" }, { status: 503 })
        }
      },
    },
  },
})
