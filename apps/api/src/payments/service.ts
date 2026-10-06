// Patient payment service (T4) - FR-5, FR-6 AC4. GATE G3 reviews the transaction
// boundary (recordPaymentSucceeded) and the idempotency logic (pay).
//
// Money rules enforced here:
//  - rule 8: payment status change, ledger posting and inventory change happen in ONE
//    transaction with a row lock (SELECT ... FOR UPDATE) on the order (and the products).
//  - rule 9: the server computes the charge from the DB snapshot (order.subtotal_cents)
//    and IGNORES any amount/price a client sends.
//  - rule 2: no split math here. The split was computed by @cerbo/money at send time and
//    persisted on the order and its lines; pay only reads those snapshots.
//  - rule 10: amounts are validated as safe integers before use.
import type { Knex } from 'knex'
import type { Seams } from '../seams/types'
import { createSeams } from '../seams'
import { assertSafeInteger } from '../db/types'
import { postPaymentJournal } from '../ledger'
import { requireString } from '../orders/validation'
import { toPatientView } from './serializer'
import type { PatientPayView, PayResult } from './types'
import {
  notFound,
  orderNotPayable,
  orderExpired,
  alreadyPaid,
  idempotencyConflict,
  paymentDeclined
} from './errors'

interface OrderRow {
  id: string
  provider_id: string
  practice_id: string
  patient_id: string
  status: string
  is_synthetic: boolean
  subtotal_cents: number | null
  reservation_expires_at: Date | null
}

interface LineRow {
  id: string
  sku: string
  qty: number
  unit_price_cents: number
  line_total_cents: number | null
  line_cogs_cents: number | null
  line_fee_cents: number | null
  line_margin_cents: number | null
}

interface PaymentRow {
  id: string
  order_id: string
  idempotency_key: string
  gateway_ref: string | null
  amount_cents: number
  is_synthetic: boolean
}

/** GET /api/pay/:token - the patient-safe view (FR-5 AC1). 404 for an unknown token. */
export async function getPayView(db: Knex, token: string): Promise<PatientPayView> {
  const order = await db<OrderRow>('orders').where('pay_token', token).first()
  if (!order) throw notFound('No order for this pay link')

  const lines = await db<LineRow>('order_lines').where('order_id', order.id).orderBy('position')
  const skus = [...new Set(lines.map((l) => l.sku))]
  const products = skus.length ? await db('products').whereIn('sku', skus).select('sku', 'name') : []
  const names = new Map<string, string>(products.map((p) => [p.sku, p.name]))
  const patient = await db('patients').where({ id: order.patient_id }).first()

  return toPatientView({
    status: order.status,
    subtotalCents: order.subtotal_cents ?? 0,
    patientFullName: patient?.name ?? '',
    lines: lines.map((l) => ({
      name: names.get(l.sku) ?? l.sku,
      qty: l.qty,
      unitPriceCents: l.unit_price_cents,
      lineTotalCents: l.line_total_cents ?? l.qty * l.unit_price_cents
    }))
  })
}

/**
 * POST /api/pay/:token - charge the patient and post the money record (FR-5 AC2/AC3/AC4).
 *
 * One transaction, order row locked up front:
 *  1. lock the order by its pay token (serialises concurrent pays - RT-04).
 *  2. idempotency / status branch:
 *       paid + same key  -> return the original result (no second charge)
 *       paid + other key -> ALREADY_PAID
 *       expired          -> ORDER_EXPIRED
 *       not sent          -> ORDER_NOT_PAYABLE
 *  3. charge the gateway for the SNAPSHOT subtotal (money rule 9). Declined -> throw
 *     PAYMENT_DECLINED and the transaction rolls back (order stays `sent`, no payment,
 *     no journal - EVAL-06d).
 *  4. record the payment: insert payment, move reserved stock to sold, post the per-line
 *     PAYMENT journal, set status `paid` - all here, inside this transaction (rule 8).
 */
export async function pay(
  db: Knex,
  token: string,
  body: unknown,
  seams: Seams = createSeams()
): Promise<PayResult> {
  const b = (body ?? {}) as Record<string, unknown>
  const idempotencyKey = requireString(b.idempotencyKey, 'idempotencyKey')
  const now = seams.clock.now()

  return db.transaction(async (trx) => {
    // Lock the order row; FOR UPDATE both serialises pays and returns the fresh row.
    const order = await trx<OrderRow>('orders').where('pay_token', token).forUpdate().first()
    if (!order) throw notFound('No order for this pay link')

    if (order.status === 'paid') {
      const existing = await trx<PaymentRow>('payments').where('order_id', order.id).first()
      if (existing && existing.idempotency_key === idempotencyKey) {
        // Same key replayed on a paid order -> the original result, no second charge.
        return { paymentId: existing.id, status: 'paid', totalCents: existing.amount_cents }
      }
      throw alreadyPaid()
    }
    if (order.status === 'expired') throw orderExpired()
    if (order.status !== 'sent') throw orderNotPayable(order.status)

    // A sent order whose reservation window already lapsed is not payable, even if the
    // expiry job has not run yet (RT-15 - no oversell past the reservation).
    if (
      order.reservation_expires_at &&
      new Date(order.reservation_expires_at).getTime() <= now.getTime()
    ) {
      throw orderExpired()
    }

    // The amount is the snapshot subtotal; any client-sent price/total is ignored (rule 9).
    const amountCents = order.subtotal_cents
    if (amountCents === null) throw orderNotPayable(order.status)
    assertSafeInteger(amountCents)

    // Charge the (stub) gateway. A decline is a normal, non-throwing result we translate.
    const charge = await seams.paymentGateway.charge(amountCents, idempotencyKey)
    if (charge.status === 'declined') throw paymentDeclined()

    const lines = await trx<LineRow>('order_lines').where('order_id', order.id).orderBy('position')
    const payment = await recordPaymentSucceeded(trx, order, lines, {
      idempotencyKey,
      gatewayRef: charge.gatewayRef,
      amountCents,
      now
    })
    return { paymentId: payment.id, status: 'paid', totalCents: payment.amount_cents }
  })
}

export interface RecordPaymentInput {
  idempotencyKey: string
  gatewayRef: string | null
  amountCents: number
  now: Date
}

/**
 * The idempotent posting core (money rule 8): insert the payment, move reserved stock to
 * sold, post the per-line PAYMENT journal, set status `paid`, write the order event -
 * ALL within the caller's transaction `trx`. Never opens or commits its own transaction,
 * so if the surrounding transaction aborts (e.g. the deferred journal-balance trigger at
 * commit), none of it persists.
 *
 * A real gateway webhook would call this same function (ARCHITECTURE section 7).
 * T9 (recurring cycles) reuses the ledger posting function; it provides its own stock
 * handling because a recurring sale has no reservation to release.
 *
 * Preconditions the caller must hold: the order row is locked and is in a payable state
 * with no existing payment.
 */
export async function recordPaymentSucceeded(
  trx: Knex.Transaction,
  order: OrderRow,
  lines: LineRow[],
  input: RecordPaymentInput
): Promise<PaymentRow> {
  if (lines.length === 0) throw orderNotPayable(order.status)

  let payment: PaymentRow
  try {
    const [row] = await trx<PaymentRow>('payments')
      .insert({
        order_id: order.id,
        idempotency_key: input.idempotencyKey,
        gateway_ref: input.gatewayRef,
        amount_cents: input.amountCents,
        is_synthetic: order.is_synthetic
      })
      .returning('*')
    payment = row
  } catch (err) {
    // A duplicate idempotency key (used on another order) or a racing second payment.
    if (isUniqueViolation(err)) {
      const constraint = String((err as { constraint?: unknown }).constraint ?? '')
      if (constraint.includes('idempotency')) throw idempotencyConflict()
      throw alreadyPaid()
    }
    throw err
  }

  // Move reserved stock to sold under a products row lock (ARCHITECTURE section 6):
  // on_hand -= qty, reserved -= qty, one `sale` movement per line. The reserved <= on_hand
  // check still holds because the send already reserved these units.
  await sellLines(trx, order.id, lines)

  // Post the per-line PAYMENT journal from the persisted split snapshot (FR-6 AC4).
  await postPaymentJournal(trx, {
    order: {
      id: order.id,
      providerId: order.provider_id,
      practiceId: order.practice_id,
      isSynthetic: order.is_synthetic
    },
    lines: lines.map((l) => ({
      id: l.id,
      lineTotalCents: l.line_total_cents as number,
      lineCogsCents: l.line_cogs_cents as number,
      lineFeeCents: l.line_fee_cents as number,
      lineMarginCents: l.line_margin_cents as number
    })),
    paymentId: payment.id
  })

  await trx('orders')
    .where({ id: order.id })
    .update({ status: 'paid', paid_at: input.now, updated_at: input.now })
  await trx('order_events').insert({
    order_id: order.id,
    from_status: order.status,
    to_status: 'paid',
    actor_user_id: null,
    note: 'payment captured'
  })

  return payment
}

/** Decrement on_hand and reserved by qty per line (the sale), with a products row lock. */
async function sellLines(trx: Knex.Transaction, orderId: string, lines: LineRow[]): Promise<void> {
  const skus = [...new Set(lines.map((l) => l.sku))].sort()
  // Lock the product rows in a deterministic order (by sku) to avoid deadlocks.
  await trx('products').whereIn('sku', skus).orderBy('sku').forUpdate()
  for (const line of lines) {
    await trx('products')
      .where({ sku: line.sku })
      .update({
        on_hand_qty: trx.raw('on_hand_qty - ?', [line.qty]),
        reserved_qty: trx.raw('reserved_qty - ?', [line.qty]),
        updated_at: trx.fn.now()
      })
    await trx('inventory_movements').insert({
      sku: line.sku,
      delta_on_hand: -line.qty,
      delta_reserved: -line.qty,
      reason: 'sale',
      order_id: orderId,
      actor_user_id: null
    })
  }
}

/** True for a Postgres unique-violation error (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
}
