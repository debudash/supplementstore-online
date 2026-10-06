// Refund service (T5) - FR-8. GATE G4 reviews the refund posting and the EVAL-07
// expectations (see apps/api/test/refunds/refunds.test.ts).
//
// Money rules enforced here:
//  - rule 2: no split math here. The amounts come from @cerbo/money's refund() applied
//    to the order's persisted split snapshot; per-line journal amounts are the snapshots.
//  - rule 6: a refund is a NEW journal (type REFUND). The original PAYMENT journal and
//    its entries are NEVER updated or deleted. Corrections are new journals.
//  - rule 7: the REFUND journal sums to zero (postRefundJournal; DB trigger at commit).
//  - rule 8: status change, ledger posting and inventory change happen in ONE
//    transaction with a row lock (SELECT ... FOR UPDATE) on the order (and products).
//  - rule 9: the server computes the refund amount from the DB snapshot, never a client.
//  - rule 10: amounts are validated as safe integers before use.
//
// Business rules (owner-approved ADRs):
//  - ADR-012: the patient receives 100% of what they paid; the platform fee is RETAINED
//    by Cerbo and charged to the provider (the provider is debited margin + fee).
//  - ADR-013: a refund BEFORE fulfillment restocks the units; a refund AFTER fulfillment
//    does NOT restock and records the COGS Cerbo writes off.
//  - ADR-014: whole-order refunds only.
//  - ADR-023: on a successful refund the patient is told to keep or safely dispose of
//    the product and NOT to return it (via the Notifier.sendRefundNotice seam, T0-owned).
//    The notice is sent AFTER the transaction commits so a notifier failure can never
//    roll back or fail the refund. The seam payload (RefundNotice) is patient-safe BY
//    CONSTRUCTION: it carries only the refunded amount and a keep/dispose flag, never
//    COGS, margin, fee, or any provider economics (NFR-5).
import type { Knex } from 'knex'
import { refund as computeRefund } from '@cerbo/money'
import { REFUND_REASON_CODES, type RefundReasonCode, type RefundResult } from '@cerbo/contracts'
import type { Actor } from '../auth/types'
import type { RefundNotice, Seams } from '../seams/types'
import { createSeams } from '../seams'
import { assertSafeInteger } from '../db/types'
import { postRefundJournal } from './posting'
import { alreadyRefunded, invalidInput, notFound, notRefundable } from './errors'

interface OrderRow {
  id: string
  provider_id: string
  practice_id: string
  patient_id: string
  status: string
  is_synthetic: boolean
  subtotal_cents: number | null
  cogs_cents: number | null
  fee_cents: number | null
  margin_cents: number | null
  fulfilled_at: Date | null
}

interface LineRow {
  id: string
  sku: string
  qty: number
  line_total_cents: number | null
  line_cogs_cents: number | null
  line_fee_cents: number | null
  line_margin_cents: number | null
}

/** Validate and narrow the request body's reason code (FR-8 AC1). */
function parseReasonCode(body: unknown): RefundReasonCode {
  const raw = (body ?? {}) as Record<string, unknown>
  const code = raw.reasonCode
  if (typeof code !== 'string' || !REFUND_REASON_CODES.includes(code as RefundReasonCode)) {
    throw invalidInput('A valid reasonCode is required', { allowed: REFUND_REASON_CODES })
  }
  return code as RefundReasonCode
}

/**
 * Resolve the order the actor is allowed to refund, or throw NOT_FOUND. A provider may
 * refund only their own orders; an unowned order 404s so existence is not leaked
 * (RT-01, AGENTS.md section 7). Cerbo Admin may refund any order. The route guards role;
 * this is the ownership half.
 */
function assertCanAct(order: OrderRow, actor: Actor): void {
  if (actor.role === 'cerbo_admin') return
  if (actor.role === 'provider' && order.provider_id === actor.providerId) return
  throw notFound('No such order', { orderId: order.id })
}

/**
 * Refund a whole paid order (FR-8). One transaction, order row locked up front so a
 * concurrent double refund (RT-08) is serialised: the second caller blocks on the lock,
 * then sees status `refunded` and gets ALREADY_REFUNDED. The unique constraint on
 * refunds.order_id is the backstop.
 *
 * The Notifier runs AFTER the transaction commits (see below) so a notifier failure can
 * never roll back or fail the refund posting (ADR-023 boundary decision).
 */
export async function refundOrder(
  db: Knex,
  actor: Actor,
  orderId: string,
  body: unknown,
  seams: Seams = createSeams()
): Promise<RefundResult> {
  const reasonCode = parseReasonCode(body)
  const now = seams.clock.now()

  // The refund runs in its own transaction and returns the data the post-commit
  // notification needs. The notifier is deliberately OUTSIDE this transaction.
  const { result, recipient } = await refundInTransaction(db, actor, orderId, reasonCode, now, seams)

  // Notify the patient AFTER commit (ADR-023 boundary decision): the refund is already
  // durable, so a notifier failure can never roll it back or corrupt the ledger. Best
  // effort - a thrown notifier is logged, not propagated.
  //
  // keepOrDispose agrees with what we actually did to inventory: a fulfilled order was
  // written off (not restocked), so the patient keeps or safely disposes and must NOT
  // return it; a refund before fulfillment restocked, so nothing shipped and there is
  // nothing to return. keepOrDispose = !restocked.
  const notice: RefundNotice = {
    refundedAmountCents: result.amountCents,
    keepOrDispose: !result.restocked
  }
  await notifyRefunded(seams, recipient, notice)

  return result
}

interface RefundRecipient {
  id: string
  name?: string
  email?: string | null
}

/** The transactional core of the refund (money rule 8). Returns the result and the
 * patient recipient for the post-commit notification. */
async function refundInTransaction(
  db: Knex,
  actor: Actor,
  orderId: string,
  reasonCode: RefundReasonCode,
  now: Date,
  seams: Seams
): Promise<{ result: RefundResult; recipient: RefundRecipient }> {
  return db.transaction(async (trx) => {
    const order = await trx<OrderRow>('orders').where('id', orderId).forUpdate().first()
    if (!order) throw notFound('No such order', { orderId })
    assertCanAct(order, actor)

    // Status branch (FR-8 AC5). The row lock means a racing refund already committed is
    // visible here as `refunded`.
    if (order.status === 'refunded') throw alreadyRefunded()
    if (order.status !== 'paid') throw notRefundable(order.status)

    // Snapshot totals (set at send); a paid order always has them. Guard defensively.
    if (
      order.subtotal_cents === null ||
      order.cogs_cents === null ||
      order.fee_cents === null ||
      order.margin_cents === null
    ) {
      throw notRefundable(order.status)
    }
    assertSafeInteger(order.subtotal_cents)
    assertSafeInteger(order.cogs_cents)
    assertSafeInteger(order.fee_cents)
    assertSafeInteger(order.margin_cents)

    // Refund amounts from @cerbo/money (money rule 2/9): patient gets 100%, the fee is
    // retained and charged to the provider (ADR-012).
    const amounts = computeRefund({
      subtotal: order.subtotal_cents,
      cogs: order.cogs_cents,
      fee: order.fee_cents,
      margin: order.margin_cents
    })

    const lines = await trx<LineRow>('order_lines').where('order_id', order.id).orderBy('position')
    if (lines.length === 0) throw notRefundable(order.status)

    // ADR-013: restock before fulfillment; write off after.
    const fulfilled = order.fulfilled_at !== null
    const restocked = !fulfilled
    const writeoffCogsCents = fulfilled ? amounts.cogsReturned : 0

    // Refund the (stub) gateway for the original payment reference (money rule 9: the
    // amount is the snapshot subtotal). Inside the transaction, mirroring the T4 charge.
    const payment = await trx('payments').where('order_id', order.id).first()
    const gateway = await seams.paymentGateway.refund(payment?.gateway_ref ?? '', amounts.patientAmount)

    // Insert the refund row. refunds.order_id is unique: a racing second refund that
    // somehow passed the status check still cannot double-insert (RT-08).
    let refundRow: { id: string }
    try {
      const [row] = await trx('refunds')
        .insert({
          order_id: order.id,
          reason_code: reasonCode,
          amount_cents: amounts.patientAmount,
          fee_retained_cents: amounts.feeRetained,
          restocked,
          writeoff_cogs_cents: writeoffCogsCents,
          gateway_ref: gateway.gatewayRef,
          actor_user_id: actor.id,
          is_synthetic: order.is_synthetic
        })
        .returning<{ id: string }[]>('id')
      refundRow = row
    } catch (err) {
      if (isUniqueViolation(err)) throw alreadyRefunded()
      throw err
    }

    // Post the per-line REFUND journal (new journal; never touches the PAYMENT journal).
    await postRefundJournal(trx, {
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
      refundId: refundRow.id
    })

    // Inventory (ADR-013). Only restock when not fulfilled; synthetic orders never touch
    // inventory (they have no reservation/sale movements either).
    if (restocked && !order.is_synthetic) {
      await restockLines(trx, order.id, lines, actor.id)
    }

    await trx('orders')
      .where({ id: order.id })
      .update({ status: 'refunded', refunded_at: now, updated_at: now })
    await trx('order_events').insert({
      order_id: order.id,
      from_status: order.status,
      to_status: 'refunded',
      actor_user_id: actor.id,
      note: `refund (${reasonCode})`
    })

    const patient = await trx('patients').where({ id: order.patient_id }).first()

    const built: RefundResult = {
      refundId: refundRow.id,
      orderId: order.id,
      status: 'refunded',
      reasonCode,
      amountCents: amounts.patientAmount,
      feeRetainedCents: amounts.feeRetained,
      restocked,
      writeoffCogsCents
    }
    return {
      result: built,
      recipient: { id: order.patient_id, name: patient?.name, email: patient?.email ?? null }
    }
  })
}

/**
 * Send the patient-safe refund notice through the Notifier seam, best effort. A thrown
 * notifier is logged, not propagated: the refund has already committed (ADR-023). See
 * the refunds tests for the exactly-one-notice / keep-or-dispose / no-economics coverage.
 */
async function notifyRefunded(seams: Seams, recipient: RefundRecipient, notice: RefundNotice): Promise<void> {
  try {
    await seams.notifier.sendRefundNotice(recipient, notice)
  } catch (err) {
    console.error('[refund:notify] failed to send refund notice (refund stands)', err)
  }
}

/**
 * Return refunded units to the shared stock pool (ADR-013, inventory table in
 * docs/ARCHITECTURE.md section 6): on_hand += qty, reserved unchanged, one
 * `refund_restock` movement per line, under a products row lock (deterministic sku order
 * to avoid deadlocks). Local to this module - the T4 payment flow likewise keeps its
 * stock mutation local; the T3 inventory service exposes only reserve/release.
 */
async function restockLines(
  trx: Knex.Transaction,
  orderId: string,
  lines: LineRow[],
  actorUserId: string | null
): Promise<void> {
  const skus = [...new Set(lines.map((l) => l.sku))].sort()
  await trx('products').whereIn('sku', skus).orderBy('sku').forUpdate()
  for (const line of lines) {
    await trx('products')
      .where({ sku: line.sku })
      .increment('on_hand_qty', line.qty)
      .update({ updated_at: trx.fn.now() })
    await trx('inventory_movements').insert({
      sku: line.sku,
      delta_on_hand: line.qty,
      delta_reserved: 0,
      reason: 'refund_restock',
      order_id: orderId,
      actor_user_id: actorUserId
    })
  }
}

/** True for a Postgres unique-violation error (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
}
