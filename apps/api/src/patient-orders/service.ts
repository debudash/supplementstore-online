// Patient "My Orders" listing service.
//
// Backs GET /api/patient/orders so a patient can find the pay link for their OWN orders
// after the fact (the pay_token is stored on the order but was only shown once, at send).
//
// SECURITY (two independent layers, both required):
//  1. Role: the route guards role = patient (app.ts). This service additionally never
//     runs for a non-patient actor.
//  2. Ownership: results are filtered to orders whose patient_id === actor.patientId. The
//     full orders table is never queryable here; another patient's orders are unreachable
//     (mirrors the practice-scoping T3 applied to the provider patients endpoint).
//
// PRIVACY: each item is built through the T4 whitelist serializer (payments/serializer.ts),
// the exact same path the pay page uses, so COGS / fee / margin / provider economics can
// never enter the response (EVAL-12, RT-10, NFR-5). This endpoint does NOT weaken the
// token model (AGENTS.md section 7): payment still happens at /api/pay/:token. It only
// surfaces the patient's own tokens; it is safe to give a patient their own token, and the
// ownership filter prevents handing out anyone else's.
import type { Knex } from 'knex'
import type { Actor } from '../auth/types'
import { toPatientView } from '../payments/serializer'
import type { PatientPayItem } from '../payments/types'
import { latestRequestsByOrder, type RefundRequestView } from '../refund-requests/service'

/** One order as the patient sees it (mirrors @cerbo/contracts PatientOrderListItem; the
 * contracts package exports only its index barrel, so the API declares the shape locally
 * and keeps it in sync - the same pattern T3/T4 use). */
export interface PatientOrderListItem {
  orderId: string
  status: string
  sentAt: string | null
  paidAt: string | null
  amountCents: number
  payToken: string | null
  payPath: string | null
  isPayable: boolean
  items: PatientPayItem[]
  /** The latest refund request on this order, if any (status, reason, dates, provider note). */
  refundRequest: RefundRequestView | null
  /** True when the patient may ask for a refund now (paid, real order, nothing pending). */
  canRequestRefund: boolean
}

export interface PatientOrdersResponse {
  orders: PatientOrderListItem[]
}

interface OrderRow {
  id: string
  patient_id: string
  status: string
  subtotal_cents: number | null
  pay_token: string | null
  sent_at: Date | null
  paid_at: Date | null
  is_synthetic: boolean
}

interface LineRow {
  order_id: string
  position: number
  sku: string
  qty: number
  unit_price_cents: number
  line_total_cents: number | null
}

function toIso(value: Date | null): string | null {
  return value ? new Date(value).toISOString() : null
}

/**
 * List the calling patient's own orders (most recently sent first). Only orders that have
 * actually been sent to the patient are listed - drafts (no token, no snapshot) are never
 * exposed. Returns an empty list for an actor with no patientId rather than leaking.
 */
export async function listPatientOrders(db: Knex, actor: Actor): Promise<PatientOrdersResponse> {
  // Defensive belt-and-braces: the route already requires role = patient, but never query
  // without a concrete owner id, or an empty/null id could widen the scope.
  if (actor.role !== 'patient' || !actor.patientId) {
    return { orders: [] }
  }
  const patientId = actor.patientId

  const orders = await db<OrderRow>('orders')
    .where({ patient_id: patientId })
    .whereNotNull('sent_at')
    .orderBy('sent_at', 'desc')
    .select('id', 'patient_id', 'status', 'subtotal_cents', 'pay_token', 'sent_at', 'paid_at', 'is_synthetic')

  if (orders.length === 0) return { orders: [] }
  const requests = await latestRequestsByOrder(db, orders.map((o) => o.id))

  // Batch the line and product-name lookups (no N+1).
  const orderIds = orders.map((o) => o.id)
  const lines = await db<LineRow>('order_lines')
    .whereIn('order_id', orderIds)
    .orderBy(['order_id', 'position'])
  const skus = [...new Set(lines.map((l) => l.sku))]
  const products = skus.length ? await db('products').whereIn('sku', skus).select('sku', 'name') : []
  const names = new Map<string, string>(products.map((p) => [p.sku, p.name]))

  const linesByOrder = new Map<string, LineRow[]>()
  for (const line of lines) {
    const bucket = linesByOrder.get(line.order_id)
    if (bucket) bucket.push(line)
    else linesByOrder.set(line.order_id, [line])
  }

  // The patient's own name (for patientFirstName in the whitelisted view). One row, our own.
  const patient = await db('patients').where({ id: patientId }).first()

  const items: PatientOrderListItem[] = orders.map((order) => {
    const orderLines = linesByOrder.get(order.id) ?? []
    // Build the patient-safe view through the SAME serializer the pay page uses; its
    // output is the only place money fields come from, so nothing else can leak.
    const view = toPatientView({
      status: order.status,
      subtotalCents: order.subtotal_cents ?? 0,
      patientFullName: patient?.name ?? '',
      lines: orderLines.map((l) => ({
        name: names.get(l.sku) ?? l.sku,
        qty: l.qty,
        unitPriceCents: l.unit_price_cents,
        lineTotalCents: l.line_total_cents ?? l.qty * l.unit_price_cents
      }))
    })

    return {
      orderId: order.id,
      status: view.status,
      sentAt: toIso(order.sent_at),
      paidAt: toIso(order.paid_at),
      amountCents: view.totalCents,
      payToken: order.pay_token,
      payPath: order.pay_token ? `/pay/${order.pay_token}` : null,
      isPayable: order.status === 'sent',
      items: view.items,
      refundRequest: requests.get(order.id) ?? null,
      canRequestRefund:
        order.status === 'paid' && !order.is_synthetic && requests.get(order.id)?.status !== 'pending'
    }
  })

  return { orders: items }
}
