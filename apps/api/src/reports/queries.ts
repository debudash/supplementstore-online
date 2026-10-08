// Report aggregate queries (T8) - FR-10, FR-11.
//
// EVERY money figure is read from ledger_entries / refunds; nothing here recomputes a
// fee, allocation, or margin (AGENTS.md money rule 2 - that math lives only in
// packages/money and was persisted at send/pay time). This module just AGGREGATES the
// recorded entries into the report shapes.
//
// BIGINT (AGENTS.md money rule 10): a SUM() over an integer column is bigint, which pg
// returns as a STRING. We cast every aggregate to ::text in SQL and route it through
// parseBigIntSafe, which asserts Number.isSafeInteger before handing back a number. A
// raw Number() here would be the exact money bug this project guards against, so there
// is no Number() on an aggregate anywhere in this file.
import type { Knex } from 'knex'
import { parseBigIntSafe } from '../db/types'
import { ACCOUNTS } from '../ledger'
import type { ResolvedPeriod } from './period'

/** Common inputs for a provider-scoped report query. */
export interface ReportScope {
  providerId: string
  period: ResolvedPeriod
  includeSynthetic: boolean
}

/** Parse a `coalesce(sum(...), 0)::text` aggregate column into a safe integer. */
function sumToInt(row: { total: string | number | null } | undefined): number {
  return parseBigIntSafe(row?.total ?? '0')
}

/**
 * Total GMV: sum of PAYMENT CASH_CLEARING debits for this provider's orders PAID in the
 * period. (METRICS.md "Total GMV": payment events count on orders.paid_at - the same basis
 * as the admin metrics and as provider net margin below, so a month's GMV, fee and margin
 * always describe the same orders. journals.posted_at is when the entry was written, which
 * for a backdated order is not the month it was paid in.)
 */
export async function queryGmvCents(db: Knex, scope: ReportScope): Promise<number> {
  const q = db('ledger_entries as le')
    .join('journals as j', 'j.id', 'le.journal_id')
    .join('orders as o', 'o.id', 'le.order_id')
    .where('le.provider_id', scope.providerId)
    .where('le.account', ACCOUNTS.CASH_CLEARING)
    .where('j.type', 'PAYMENT')
    .where('o.paid_at', '>=', scope.period.startTs)
    .where('o.paid_at', '<', scope.period.endTsExclusive)
  if (!scope.includeSynthetic) q.where('le.is_synthetic', false)
  const row = await q.select(db.raw('coalesce(sum(le.amount_cents), 0)::text as total')).first<{ total: string }>()
  return sumToInt(row)
}

/**
 * Platform fee revenue: -(sum of PLATFORM_FEE_REVENUE entries) for this provider's orders
 * PAID in the period (orders.paid_at basis, like GMV). Fees are credits (negative), so
 * negating yields a positive revenue figure. Includes fees on orders later refunded
 * (retained) because REFUND never touches PLATFORM_FEE_REVENUE.
 */
export async function queryPlatformFeeCents(db: Knex, scope: ReportScope): Promise<number> {
  const q = db('ledger_entries as le')
    .join('journals as j', 'j.id', 'le.journal_id')
    .join('orders as o', 'o.id', 'le.order_id')
    .where('le.provider_id', scope.providerId)
    .where('le.account', ACCOUNTS.PLATFORM_FEE_REVENUE)
    .where('j.type', 'PAYMENT')
    .where('o.paid_at', '>=', scope.period.startTs)
    .where('o.paid_at', '<', scope.period.endTsExclusive)
  if (!scope.includeSynthetic) q.where('le.is_synthetic', false)
  const row = await q.select(db.raw('coalesce(sum(le.amount_cents), 0)::text as total')).first<{ total: string }>()
  return -sumToInt(row)
}

/**
 * Refunded GMV: sum of refunds.amount_cents in the period for this provider's orders.
 * (METRICS.md "Refunded GMV", basis refund created_at.)
 */
export async function queryRefundedGmvCents(db: Knex, scope: ReportScope): Promise<number> {
  const q = db('refunds as r')
    .join('orders as o', 'o.id', 'r.order_id')
    .where('o.provider_id', scope.providerId)
    .where('r.created_at', '>=', scope.period.startTs)
    .where('r.created_at', '<', scope.period.endTsExclusive)
  if (!scope.includeSynthetic) q.where('r.is_synthetic', false)
  const row = await q.select(db.raw('coalesce(sum(r.amount_cents), 0)::text as total')).first<{ total: string }>()
  return sumToInt(row)
}

/**
 * Sunk fees on refunded GMV: sum of refunds.fee_retained_cents in the period.
 * (METRICS.md "Sunk fees on refunded GMV".)
 */
export async function querySunkFeeCents(db: Knex, scope: ReportScope): Promise<number> {
  const q = db('refunds as r')
    .join('orders as o', 'o.id', 'r.order_id')
    .where('o.provider_id', scope.providerId)
    .where('r.created_at', '>=', scope.period.startTs)
    .where('r.created_at', '<', scope.period.endTsExclusive)
  if (!scope.includeSynthetic) q.where('r.is_synthetic', false)
  const row = await q
    .select(db.raw('coalesce(sum(r.fee_retained_cents), 0)::text as total'))
    .first<{ total: string }>()
  return sumToInt(row)
}

/**
 * Provider net margin from settled sales: sum of orders.margin_cents over orders paid
 * in the period and NOT refunded (no refund row). (METRICS.md "Provider net margin
 * from settled sales".) margin_cents was persisted at send time from packages/money.
 */
export async function queryProviderNetMarginCents(db: Knex, scope: ReportScope): Promise<number> {
  const q = db('orders as o')
    .where('o.provider_id', scope.providerId)
    .where('o.paid_at', '>=', scope.period.startTs)
    .where('o.paid_at', '<', scope.period.endTsExclusive)
    .whereNotNull('o.margin_cents')
    .whereNotExists(function () {
      this.select('*').from('refunds as r').whereRaw('r.order_id = o.id')
    })
  if (!scope.includeSynthetic) q.where('o.is_synthetic', false)
  const row = await q.select(db.raw('coalesce(sum(o.margin_cents), 0)::text as total')).first<{ total: string }>()
  return sumToInt(row)
}

/** Units sold per SKU on the provider's orders paid in the period (qty, not money). */
export async function queryUnitsBySku(
  db: Knex,
  scope: ReportScope
): Promise<Array<{ sku: string; name: string; units: number }>> {
  const q = db('order_lines as ol')
    .join('orders as o', 'o.id', 'ol.order_id')
    .join('products as p', 'p.sku', 'ol.sku')
    .where('o.provider_id', scope.providerId)
    .where('o.paid_at', '>=', scope.period.startTs)
    .where('o.paid_at', '<', scope.period.endTsExclusive)
  if (!scope.includeSynthetic) q.where('o.is_synthetic', false)
  const rows = await q
    .groupBy('ol.sku', 'p.name')
    .orderBy('ol.sku')
    .select('ol.sku as sku', 'p.name as name', db.raw('coalesce(sum(ol.qty), 0)::text as units'))
  return rows.map((r: { sku: string; name: string; units: string }) => ({
    sku: r.sku,
    name: r.name,
    units: parseBigIntSafe(r.units)
  }))
}

/** Provider's orders created in the period, grouped by current status. */
export async function queryOrdersByStatus(
  db: Knex,
  scope: ReportScope
): Promise<Array<{ status: string; count: number }>> {
  const q = db('orders as o')
    .where('o.provider_id', scope.providerId)
    .where('o.created_at', '>=', scope.period.startTs)
    .where('o.created_at', '<', scope.period.endTsExclusive)
  if (!scope.includeSynthetic) q.where('o.is_synthetic', false)
  const rows = await q
    .groupBy('o.status')
    .orderBy('o.status')
    .select('o.status as status', db.raw('count(*)::text as count'))
  return rows.map((r: { status: string; count: string }) => ({
    status: r.status,
    count: parseBigIntSafe(r.count)
  }))
}

/**
 * Payable balance owed to the provider = -(sum of PROVIDER_PAYABLE entries) posted
 * strictly before `before`. Used for the opening balance (ARCHITECTURE section 5:
 * "Provider balance owed = -(sum of PROVIDER_PAYABLE)").
 */
export async function queryPayableBalanceBefore(
  db: Knex,
  providerId: string,
  before: Date,
  includeSynthetic: boolean
): Promise<number> {
  const q = db('ledger_entries as le')
    .join('journals as j', 'j.id', 'le.journal_id')
    .where('le.provider_id', providerId)
    .where('le.account', ACCOUNTS.PROVIDER_PAYABLE)
    .where('j.posted_at', '<', before)
  if (!includeSynthetic) q.where('le.is_synthetic', false)
  const row = await q.select(db.raw('coalesce(sum(le.amount_cents), 0)::text as total')).first<{ total: string }>()
  return -sumToInt(row)
}

/**
 * Credits (margins earned) and debits (reversals + fee retentions) on PROVIDER_PAYABLE
 * in the period. Credits are the negated sum of negative entries; debits are the sum of
 * positive entries. (FR-11 AC2.)
 */
export async function queryPayableMovement(
  db: Knex,
  scope: ReportScope
): Promise<{ creditsCents: number; debitsCents: number }> {
  const q = db('ledger_entries as le')
    .join('journals as j', 'j.id', 'le.journal_id')
    .where('le.provider_id', scope.providerId)
    .where('le.account', ACCOUNTS.PROVIDER_PAYABLE)
    .where('j.posted_at', '>=', scope.period.startTs)
    .where('j.posted_at', '<', scope.period.endTsExclusive)
  if (!scope.includeSynthetic) q.where('le.is_synthetic', false)
  const row = await q
    .select(
      db.raw('coalesce(sum(case when le.amount_cents < 0 then -le.amount_cents else 0 end), 0)::text as credits'),
      db.raw('coalesce(sum(case when le.amount_cents > 0 then le.amount_cents else 0 end), 0)::text as debits')
    )
    .first<{ credits: string; debits: string }>()
  return {
    creditsCents: parseBigIntSafe(row?.credits ?? '0'),
    debitsCents: parseBigIntSafe(row?.debits ?? '0')
  }
}

/** Per-order credit/debit movement on PROVIDER_PAYABLE in the period (FR-11 AC2). */
export async function queryPayableContributingOrders(
  db: Knex,
  scope: ReportScope
): Promise<Array<{ orderId: string; creditsCents: number; debitsCents: number; netCents: number }>> {
  const q = db('ledger_entries as le')
    .join('journals as j', 'j.id', 'le.journal_id')
    .where('le.provider_id', scope.providerId)
    .where('le.account', ACCOUNTS.PROVIDER_PAYABLE)
    .where('j.posted_at', '>=', scope.period.startTs)
    .where('j.posted_at', '<', scope.period.endTsExclusive)
  if (!scope.includeSynthetic) q.where('le.is_synthetic', false)
  const rows = await q
    .groupBy('le.order_id')
    .orderBy('le.order_id')
    .select(
      'le.order_id as order_id',
      db.raw('coalesce(sum(case when le.amount_cents < 0 then -le.amount_cents else 0 end), 0)::text as credits'),
      db.raw('coalesce(sum(case when le.amount_cents > 0 then le.amount_cents else 0 end), 0)::text as debits')
    )
  return rows.map((r: { order_id: string; credits: string; debits: string }) => {
    const creditsCents = parseBigIntSafe(r.credits)
    const debitsCents = parseBigIntSafe(r.debits)
    return { orderId: r.order_id, creditsCents, debitsCents, netCents: creditsCents - debitsCents }
  })
}

/**
 * Provider ids with any PROVIDER_PAYABLE activity posted before `before` (i.e. a
 * payable history to settle). Used by the month close to know which providers get a
 * statement. Real (non-synthetic) entries only - statements are payout artifacts.
 */
export async function queryProvidersWithPayableActivity(
  db: Knex,
  before: Date
): Promise<Array<{ providerId: string; practiceId: string }>> {
  const rows = await db('ledger_entries as le')
    .join('journals as j', 'j.id', 'le.journal_id')
    .where('le.account', ACCOUNTS.PROVIDER_PAYABLE)
    .where('le.is_synthetic', false)
    .where('j.posted_at', '<', before)
    .whereNotNull('le.provider_id')
    .whereNotNull('le.practice_id')
    .groupBy('le.provider_id', 'le.practice_id')
    .orderBy('le.provider_id')
    .select('le.provider_id as providerId', 'le.practice_id as practiceId')
  return rows as Array<{ providerId: string; practiceId: string }>
}
