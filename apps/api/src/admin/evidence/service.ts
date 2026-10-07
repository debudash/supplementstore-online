// Cerbo Admin "Evidence" (read-only): live proof that the money is right, plus the
// unit economics and refund exposure behind the business case.
//
//  - integrity: every journal sums to zero, every paid/refunded order passes its audit
//    invariants (the same checks the per-order audit runs), stock is consistent, the
//    append-only database guards exist, and the ledger reconciles with the owner formula.
//  - unit economics: platform fee vs ESTIMATED card processing (2.9% + 30c by default,
//    adjustable) per order, Cerbo's net, and the break-even fee.
//  - refund exposure: refund rate, fees kept, COGS written off (ADR-012/013), by reason.
//
// Every fee/processing/average figure comes from @cerbo/money (money rule 2); the rest are
// sums and counts read from the ledger and snapshots.
import type { Knex } from 'knex'
import {
  processingCostCents,
  breakevenFeeBps,
  averageCents,
  DEFAULT_FEE_BPS,
  DEFAULT_PROCESSING_RATE_BPS,
  DEFAULT_PROCESSING_FIXED_CENTS
} from '@cerbo/money'
import { loadAudit } from '../../ledger'
import { getAdminMetrics } from '../metrics/service'
import { invalidInput } from '../errors'
import { parseBigIntSafe } from '../../db/types'

const MAX_ORDERS_CHECKED = 500
const MAX_FAILURES_LISTED = 20

/** Append-only / balance guards the database must have (migrations 5 and 7). */
const EXPECTED_GUARDS = [
  'journals_no_update',
  'journals_no_delete',
  'ledger_entries_no_update',
  'ledger_entries_no_delete',
  'ledger_entries_balanced',
  'payments_no_update',
  'payments_no_delete',
  'refunds_no_update',
  'refunds_no_delete',
  'payable_statements_no_update',
  'payable_statements_no_delete',
  'product_price_changes_no_update',
  'product_price_changes_no_delete'
]

export interface EvidenceOpts {
  includeSynthetic?: boolean
  processingRateBps?: unknown
  processingFixedCents?: unknown
}

function intParam(raw: unknown, field: string, def: number, max: number): number {
  if (raw === undefined || raw === null || raw === '') return def
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > max) {
    throw invalidInput(`${field} must be an integer from 0 to ${max}`, { field })
  }
  return n
}

/** Integer basis points of part / whole (floor); null when whole is 0. Not money. */
function rateBps(part: number, whole: number): number | null {
  return whole > 0 ? Math.floor((part * 10000) / whole) : null
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function getEvidence(db: Knex, opts: EvidenceOpts) {
  const includeSynthetic = opts.includeSynthetic ?? false
  const procRate = intParam(opts.processingRateBps, 'processingRateBps', DEFAULT_PROCESSING_RATE_BPS, 2000)
  const procFixed = intParam(opts.processingFixedCents, 'processingFixedCents', DEFAULT_PROCESSING_FIXED_CENTS, 1000)
  const synthetic = (q: Knex.QueryBuilder, col: string) => (includeSynthetic ? q : q.where(col, false))

  // ---- Integrity ----
  const [journalTotal] = await synthetic(db('journals'), 'is_synthetic').count<{ count: string }[]>('* as count')
  const unbalanced = await db('ledger_entries as le')
    .join('journals as j', 'j.id', 'le.journal_id')
    .modify((q) => (includeSynthetic ? q : q.where('j.is_synthetic', false)))
    .groupBy('le.journal_id')
    .havingRaw('sum(le.amount_cents) <> 0')
    .select('le.journal_id')

  const orderRows: Array<{ id: string }> = await synthetic(
    db('orders').whereIn('status', ['paid', 'refunded']),
    'is_synthetic'
  )
    .orderBy('created_at', 'desc')
    .limit(MAX_ORDERS_CHECKED)
    .select('id')
  const failingOrders: Array<{ orderId: string; failedChecks: string[] }> = []
  let ordersPassing = 0
  for (const o of orderRows) {
    const audit = await loadAudit(db, o.id)
    if (!audit) continue
    if (audit.invariants.ok) ordersPassing += 1
    else if (failingOrders.length < MAX_FAILURES_LISTED) {
      failingOrders.push({ orderId: o.id, failedChecks: audit.invariants.checks.filter((c) => !c.pass).map((c) => c.name) })
    }
  }

  const stockIssues: Array<{ sku: string; on_hand_qty: number; reserved_qty: number }> = await db('products')
    .where('on_hand_qty', '<', 0)
    .orWhere('reserved_qty', '<', 0)
    .orWhereRaw('reserved_qty > on_hand_qty')
    .select('sku', 'on_hand_qty', 'reserved_qty')

  const triggerRows: Array<{ tgname: string }> = (
    await db.raw('select tgname from pg_trigger where not tgisinternal and tgname = any(?)', [EXPECTED_GUARDS])
  ).rows
  const present = new Set(triggerRows.map((r) => r.tgname))
  const missingGuards = EXPECTED_GUARDS.filter((g) => !present.has(g))

  const allTime = await getAdminMetrics(db, { from: '2000-01-01', to: todayUtc(), includeSynthetic })

  // ---- Unit economics (paid orders, including ones later refunded) ----
  const paidOrders: Array<{ subtotal_cents: number; fee_cents: number }> = await synthetic(
    db('orders').whereNotNull('paid_at').whereNotNull('subtotal_cents'),
    'is_synthetic'
  ).select('subtotal_cents', 'fee_cents')
  let gmvCents = 0
  let platformFeeCents = 0
  let processingCents = 0
  for (const o of paidOrders) {
    gmvCents += o.subtotal_cents
    platformFeeCents += o.fee_cents ?? 0
    processingCents += processingCostCents(o.subtotal_cents, procRate, procFixed)
  }
  const orderCount = paidOrders.length
  const aovCents = averageCents(gmvCents, orderCount)

  // ---- Refund exposure ----
  const refundRows: Array<{
    reason_code: string
    amount_cents: number
    fee_retained_cents: number
    writeoff_cogs_cents: number
    restocked: boolean
  }> = await synthetic(db('refunds'), 'is_synthetic').select(
    'reason_code',
    'amount_cents',
    'fee_retained_cents',
    'writeoff_cogs_cents',
    'restocked'
  )
  const byReason = new Map<string, { count: number; amountCents: number }>()
  let refundedCents = 0
  let feeRetainedCents = 0
  let writeoffCents = 0
  let restockedCount = 0
  for (const r of refundRows) {
    refundedCents += r.amount_cents
    feeRetainedCents += r.fee_retained_cents
    writeoffCents += r.writeoff_cogs_cents
    if (r.restocked) restockedCount += 1
    const b = byReason.get(r.reason_code) ?? { count: 0, amountCents: 0 }
    b.count += 1
    b.amountCents += r.amount_cents
    byReason.set(r.reason_code, b)
  }

  const cerboNetCents = platformFeeCents - processingCents
  return {
    generatedAt: new Date().toISOString(),
    includeSynthetic,
    integrity: {
      journals: { total: parseBigIntSafe(journalTotal?.count ?? '0'), unbalanced: unbalanced.length },
      orders: {
        checked: orderRows.length,
        passing: ordersPassing,
        failing: orderRows.length - ordersPassing,
        capped: orderRows.length >= MAX_ORDERS_CHECKED,
        failures: failingOrders
      },
      stock: { issues: stockIssues.map((s) => ({ sku: s.sku, onHandQty: s.on_hand_qty, reservedQty: s.reserved_qty })) },
      guards: { expected: EXPECTED_GUARDS.length, present: EXPECTED_GUARDS.length - missingGuards.length, missing: missingGuards },
      reconciliation: allTime.reconciliation
    },
    unitEconomics: {
      assumptions: { processingRateBps: procRate, processingFixedCents: procFixed, platformFeeBps: DEFAULT_FEE_BPS },
      orderCount,
      gmvCents,
      platformFeeCents,
      processingCostCents: processingCents,
      cerboNetCents,
      perOrder: {
        aovCents,
        platformFeeCents: averageCents(platformFeeCents, orderCount),
        processingCostCents: averageCents(processingCents, orderCount),
        cerboNetCents: averageCents(cerboNetCents, orderCount)
      },
      breakevenFeeBps: aovCents > 0 ? breakevenFeeBps(aovCents, procRate, procFixed) : null
    },
    refundExposure: {
      refundCount: refundRows.length,
      paidOrderCount: orderCount,
      refundRateBps: rateBps(refundRows.length, orderCount),
      refundedCents,
      feeRetainedCents,
      cogsWrittenOffCents: writeoffCents,
      restockedCount,
      writtenOffCount: refundRows.length - restockedCount,
      byReason: [...byReason.entries()]
        .map(([reasonCode, v]) => ({ reasonCode, count: v.count, amountCents: v.amountCents }))
        .sort((a, b) => b.count - a.count),
      cerboNetAfterWriteoffsCents: cerboNetCents - writeoffCents
    }
  }
}
