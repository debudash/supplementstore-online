// Audit query (T4) - FR-7 AC1.
//
// Assembles the full money record for one order: snapshot, lines, status history,
// payments, refunds, journals with entries, inventory movements, and an explicit
// invariants block where each check passes or fails on its own. Read-only. Callers
// (the provider and Cerbo Admin audit routes) do the ownership check; this function
// only loads by id and returns null when the order does not exist.
import type { Knex } from 'knex'
import type {
  AuditResponse,
  AuditLine,
  AuditJournal,
  AuditLedgerEntry,
  InvariantCheck
} from './types'
import { priceFromMarkupCents } from '@cerbo/money'
import { assertSafeInteger } from '../db/types'

const iso = (d: Date | string | null): string | null =>
  d === null ? null : new Date(d).toISOString()

interface OrderRow {
  id: string
  status: string
  kind: string
  provider_id: string
  practice_id: string
  patient_id: string
  fee_bps: number
  subtotal_cents: number | null
  cogs_cents: number | null
  fee_cents: number | null
  margin_cents: number | null
  is_synthetic: boolean
  created_at: Date
  sent_at: Date | null
  paid_at: Date | null
  fulfilled_at: Date | null
  cancelled_at: Date | null
  expired_at: Date | null
  refunded_at: Date | null
  pay_token: string | null
}

interface LineRow {
  id: string
  position: number
  sku: string
  qty: number
  unit_price_cents: number
  unit_cogs_cents: number
  unit_markup_cents: number | null
  line_total_cents: number | null
  line_cogs_cents: number | null
  line_fee_cents: number | null
  line_margin_cents: number | null
}

interface JournalRow {
  id: string
  type: 'PAYMENT' | 'REFUND'
  ref_id: string | null
  is_synthetic: boolean
  posted_at: Date
}

interface EntryRow {
  id: number
  journal_id: string
  line_id: string | null
  account: AuditLedgerEntry['account']
  amount_cents: number
  memo: string | null
}

/**
 * Load the complete audit record for an order, or null if no such order.
 * The invariants block re-derives the money checks from the stored data so a reviewer
 * (or EVAL-06c) can confirm nothing drifted after the order was paid.
 */
export async function loadAudit(db: Knex, orderId: string): Promise<AuditResponse | null> {
  const order = await db<OrderRow>('orders').where({ id: orderId }).first()
  if (!order) return null

  const [lineRows, events, payments, refunds, journalRows, movements] = await Promise.all([
    db<LineRow>('order_lines').where('order_id', orderId).orderBy('position'),
    db('order_events').where('order_id', orderId).orderBy('at').orderBy('id'),
    db('payments').where('order_id', orderId).orderBy('created_at'),
    db('refunds').where('order_id', orderId).orderBy('created_at'),
    db<JournalRow>('journals').where('order_id', orderId).orderBy('posted_at').orderBy('id'),
    db('inventory_movements').where('order_id', orderId).orderBy('id')
  ])

  const skus = [...new Set(lineRows.map((l) => l.sku))]
  const productRows = skus.length
    ? await db('products').whereIn('sku', skus).select('sku', 'name')
    : []
  const names = new Map<string, string>(productRows.map((p) => [p.sku, p.name]))

  // Display names for the people on the order (audit is provider/admin-only).
  const [patientRow, providerRow, practiceRow] = await Promise.all([
    db('patients').where({ id: order.patient_id }).first('name'),
    db('providers').where({ id: order.provider_id }).first('name'),
    db('practices').where({ id: order.practice_id }).first('name')
  ])

  const journalIds = journalRows.map((j) => j.id)
  const entryRows: EntryRow[] = journalIds.length
    ? await db<EntryRow>('ledger_entries').whereIn('journal_id', journalIds).orderBy('id')
    : []
  const entriesByJournal = new Map<string, EntryRow[]>()
  for (const e of entryRows) {
    const list = entriesByJournal.get(e.journal_id) ?? []
    list.push(e)
    entriesByJournal.set(e.journal_id, list)
  }

  const lines: AuditLine[] = lineRows.map((l) => ({
    id: l.id,
    position: l.position,
    sku: l.sku,
    name: names.get(l.sku) ?? l.sku,
    qty: l.qty,
    unitPriceCents: l.unit_price_cents,
    unitCogsCents: l.unit_cogs_cents,
    unitMarkupCents: l.unit_markup_cents,
    lineTotalCents: l.line_total_cents,
    lineCogsCents: l.line_cogs_cents,
    lineFeeCents: l.line_fee_cents,
    lineMarginCents: l.line_margin_cents
  }))

  const journals: AuditJournal[] = journalRows.map((j) => {
    const es = entriesByJournal.get(j.id) ?? []
    const entrySum = es.reduce((a, e) => a + e.amount_cents, 0)
    return {
      id: j.id,
      type: j.type,
      refId: j.ref_id,
      isSynthetic: j.is_synthetic,
      postedAt: new Date(j.posted_at).toISOString(),
      entries: es.map((e) => ({
        id: e.id,
        account: e.account,
        lineId: e.line_id,
        amountCents: e.amount_cents,
        memo: e.memo
      })),
      entrySumCents: entrySum,
      sumsToZero: entrySum === 0
    }
  })

  const invariants = computeInvariants(order, lineRows, journals, payments)

  return {
    order: {
      id: order.id,
      status: order.status,
      kind: order.kind,
      providerId: order.provider_id,
      practiceId: order.practice_id,
      patientId: order.patient_id,
      patientName: patientRow?.name ?? null,
      providerName: providerRow?.name ?? null,
      practiceName: practiceRow?.name ?? null,
      feeBps: order.fee_bps,
      subtotalCents: order.subtotal_cents,
      cogsCents: order.cogs_cents,
      feeCents: order.fee_cents,
      marginCents: order.margin_cents,
      isSynthetic: order.is_synthetic,
      createdAt: new Date(order.created_at).toISOString(),
      sentAt: iso(order.sent_at),
      paidAt: iso(order.paid_at),
      fulfilledAt: iso(order.fulfilled_at),
      cancelledAt: iso(order.cancelled_at),
      expiredAt: iso(order.expired_at),
      refundedAt: iso(order.refunded_at),
      // The pay link, so the audit view can surface it after send (provider/admin surface,
      // already ownership/role-guarded upstream). Null for drafts.
      payToken: order.pay_token,
      payPath: order.pay_token ? `/pay/${order.pay_token}` : null
    },
    lines,
    statusHistory: events.map((e) => ({
      fromStatus: e.from_status,
      toStatus: e.to_status,
      actorUserId: e.actor_user_id,
      at: new Date(e.at).toISOString(),
      note: e.note
    })),
    payments: payments.map((p) => ({
      id: p.id,
      idempotencyKey: p.idempotency_key,
      gatewayRef: p.gateway_ref,
      amountCents: p.amount_cents,
      isSynthetic: p.is_synthetic,
      createdAt: new Date(p.created_at).toISOString()
    })),
    refunds: refunds.map((r) => ({
      id: r.id,
      reasonCode: r.reason_code,
      amountCents: r.amount_cents,
      feeRetainedCents: r.fee_retained_cents,
      restocked: r.restocked,
      writeoffCogsCents: r.writeoff_cogs_cents,
      gatewayRef: r.gateway_ref,
      actorUserId: r.actor_user_id,
      isSynthetic: r.is_synthetic,
      createdAt: new Date(r.created_at).toISOString()
    })),
    inventoryMovements: movements.map((m) => ({
      id: m.id,
      sku: m.sku,
      deltaOnHand: m.delta_on_hand,
      deltaReserved: m.delta_reserved,
      reason: m.reason,
      createdAt: new Date(m.created_at).toISOString()
    })),
    journals,
    invariants
  }
}

/**
 * Re-derive the money invariants from stored data. Each check is explicit (FR-7 AC1);
 * checks that do not apply to the order's current stage (e.g. payment checks before
 * payment) are simply omitted rather than reported as failures.
 */
function computeInvariants(
  order: OrderRow,
  lines: LineRow[],
  journals: AuditJournal[],
  payments: Array<{ amount_cents: number }>
): AuditResponse['invariants'] {
  const checks: InvariantCheck[] = []

  const totalsPresent =
    order.subtotal_cents !== null &&
    order.cogs_cents !== null &&
    order.fee_cents !== null &&
    order.margin_cents !== null

  if (totalsPresent) {
    const subtotal = order.subtotal_cents as number
    const cogs = order.cogs_cents as number
    const fee = order.fee_cents as number
    const margin = order.margin_cents as number
    checks.push({
      name: 'order.split_balances',
      pass: subtotal === cogs + fee + margin,
      detail: { subtotal, cogs, fee, margin }
    })
    checks.push({ name: 'order.margin_nonnegative', pass: margin >= 0, detail: { margin } })

    // Per-line balance (money rule 5) and fee-allocation sum (ADR-003 / money rule 2,4).
    const priced = lines.filter((l) => l.line_total_cents !== null)
    let lineFeeSum = 0
    const offenders: number[] = []
    for (const l of priced) {
      const t = l.line_total_cents as number
      const c = l.line_cogs_cents as number
      const f = l.line_fee_cents as number
      const m = l.line_margin_cents as number
      lineFeeSum += f
      if (t !== c + f + m || m < 0) offenders.push(l.position)
    }
    checks.push({
      name: 'lines.split_balances',
      pass: offenders.length === 0,
      detail: { offendingPositions: offenders }
    })
    checks.push({
      name: 'lines.fee_allocation_sums_to_order_fee',
      pass: lineFeeSum === fee,
      detail: { lineFeeSum, orderFee: fee }
    })

    // ADR-028: a line priced from a markup carries exactly the price that markup derives
    // from its snapshot COGS, and the provider nets at least what they marked up.
    // Lines priced before ADR-028 have no markup and are not checked here.
    const tracked = priced.filter((l) => l.unit_markup_cents !== null)
    const priceMismatch = tracked
      .filter(
        (l) =>
          l.line_total_cents !== l.qty * l.unit_price_cents ||
          l.unit_price_cents !== priceFromMarkupCents(l.unit_cogs_cents, l.unit_markup_cents as number, order.fee_bps)
      )
      .map((l) => l.position)
    checks.push({
      name: 'lines.price_matches_markup',
      pass: priceMismatch.length === 0,
      detail: { offendingPositions: priceMismatch, trackedLines: tracked.length }
    })
    if (tracked.length > 0 && tracked.length === priced.length) {
      const markupTotal = tracked.reduce((a, l) => a + l.qty * (l.unit_markup_cents as number), 0)
      checks.push({
        name: 'order.margin_covers_markup',
        pass: margin >= markupTotal,
        detail: { margin, markupTotal }
      })
    }
  }

  // Every journal sums to zero (money rule 7). One check per journal.
  for (const j of journals) {
    checks.push({
      name: `journal.${j.id}.sums_to_zero`,
      pass: j.sumsToZero,
      detail: { type: j.type, entrySumCents: j.entrySumCents }
    })
  }

  // If paid: the recorded payment equals the order subtotal, and the PAYMENT journal's
  // CASH_CLEARING entries equal that subtotal (money rule 9 - server charged the snapshot).
  if (totalsPresent && payments.length > 0) {
    const subtotal = order.subtotal_cents as number
    const paidTotal = payments.reduce((a, p) => a + p.amount_cents, 0)
    checks.push({
      name: 'payment.amount_matches_subtotal',
      pass: paidTotal === subtotal,
      detail: { paidTotal, subtotal }
    })
    const paymentJournal = journals.find((j) => j.type === 'PAYMENT')
    if (paymentJournal) {
      const cash = paymentJournal.entries
        .filter((e) => e.account === 'CASH_CLEARING')
        .reduce((a, e) => a + e.amountCents, 0)
      checks.push({
        name: 'ledger.cash_clearing_matches_subtotal',
        pass: cash === subtotal,
        detail: { cashClearing: cash, subtotal }
      })
    }
  }

  // Guard: all amounts are safe integers (money rule 10 - no bigint drift).
  for (const p of payments) assertSafeInteger(p.amount_cents)

  return { ok: checks.every((c) => c.pass), checks }
}
