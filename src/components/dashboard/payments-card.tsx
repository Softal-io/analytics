import { Button } from "@cloudflare/kumo/components/button"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import type { PaymentRow, PaymentTotal } from "@/lib/payments"
import { CountryFlag } from "@/components/dashboard/icons"
import { formatPercent, formatReferrer } from "@/lib/format"

/** Amounts are stored in the currency's minor unit, which Intl knows the size of. */
function formatMoney(minorUnits: number, currency: string): string {
  try {
    const format = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    })
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2
    return format.format(minorUnits / 10 ** digits)
  } catch {
    return `${(minorUnits / 100).toFixed(2)} ${currency.toUpperCase()}`
  }
}

function paymentSource(row: PaymentRow): string {
  if (!row.attributed) return "No visit recorded"
  const source =
    row.utmCampaign ??
    row.utmSource ??
    formatReferrer(row.referrerDomain ?? "(unknown)")
  return row.entryPage ? `${source} → ${row.entryPage}` : source
}

export function PaymentsCard({
  totals,
  payments,
  paidVisits,
  visits,
  rows,
  timezone,
  loading,
  error,
  onRetry,
  paidOnly,
  onPaidOnlyChange,
}: {
  totals: Array<PaymentTotal>
  payments: number
  paidVisits: number
  /** Visits in the same report, the denominator of the conversion rate. */
  visits?: number
  rows: Array<PaymentRow>
  timezone: string
  loading: boolean
  error?: string
  onRetry: () => void
  paidOnly: boolean
  onPaidOnlyChange: (value: boolean) => void
}) {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
  return (
    <LayerCard role="region" aria-label="Payments" className="sm:col-span-2">
      <LayerCard.Secondary>
        <div className="flex w-full items-center justify-between gap-2">
          <span>Payments</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-pressed={paidOnly}
            title="Filter every card to the visits that led to a payment"
            className={
              paidOnly
                ? "bg-kumo-fill text-kumo-default hover:bg-kumo-fill"
                : "text-kumo-subtle opacity-50 hover:opacity-100"
            }
            onClick={() => onPaidOnlyChange(!paidOnly)}
          >
            Paying visits only
          </Button>
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary className="h-full p-2.5">
        {loading || error || payments === 0 ? (
          <div className="flex h-24 items-center justify-center">
            <div role="status" className="text-center text-sm text-kumo-subtle">
              <p>
                {loading
                  ? "Loading…"
                  : (error ?? "No payments from these visits in this period")}
              </p>
              {error && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="mt-2 underline underline-offset-4"
                >
                  Try again
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <dl className="mb-2 flex flex-wrap gap-x-6 gap-y-1 px-2 text-sm">
              <div className="flex items-baseline gap-1.5">
                <dt className="text-kumo-subtle">Revenue</dt>
                <dd className="font-medium text-kumo-default tabular-nums">
                  {totals
                    .map((total) => formatMoney(total.revenue, total.currency))
                    .join(" + ")}
                </dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-kumo-subtle">Payments</dt>
                <dd className="font-medium text-kumo-default tabular-nums">
                  {payments.toLocaleString()}
                </dd>
              </div>
              {visits !== undefined && visits > 0 && (
                <div
                  className="flex items-baseline gap-1.5"
                  title="Visits that led to a payment, out of all visits in this report"
                >
                  <dt className="text-kumo-subtle">Visits that paid</dt>
                  <dd className="font-medium text-kumo-default tabular-nums">
                    {formatPercent(Math.min(1, paidVisits / visits))}
                  </dd>
                </div>
              )}
            </dl>
            <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto pr-1">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-sm text-kumo-subtle"
                >
                  {row.country && <CountryFlag country={row.country} />}
                  <span className="min-w-0 shrink truncate text-kumo-default">
                    {row.product ?? "Order"}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {paymentSource(row)}
                  </span>
                  <span className="hidden shrink-0 text-xs tabular-nums sm:inline">
                    {time.format(row.paidAt * 1000)}
                  </span>
                  <span
                    className={`shrink-0 font-medium tabular-nums ${
                      row.status === "refunded"
                        ? "text-kumo-subtle line-through"
                        : "text-kumo-default"
                    }`}
                    title={
                      row.status === "paid"
                        ? undefined
                        : row.status === "refunded"
                          ? "Refunded"
                          : `Partly refunded: ${formatMoney(row.refundedAmount, row.currency)}`
                    }
                  >
                    {formatMoney(row.amount, row.currency)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </LayerCard.Primary>
    </LayerCard>
  )
}
