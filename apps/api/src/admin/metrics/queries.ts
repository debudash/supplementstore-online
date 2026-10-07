// Cerbo Admin metrics aggregate queries (T10) - FR-13, docs/METRICS.md.
//
// BASIS (docs/METRICS.md line 4): payment events count on orders.paid_at, refund events
// on refunds.created_at. We therefore filter PAYMENT-journal aggregates by the ORDER's
// paid_at (joined in), not journals.posted_at. This matches the spec and lets the demo
// generator's injected Clock place synthetic activity in past months via paid_at (the
// real posting code fixes journals.posted_at = now() and the ledger is append-only).
//
// MONEY RULES: no split math here (rule 2) - every figure is read from ledger_entries,
// refunds, orders, or baseline tables. Every SUM/COUNT is bigint, which pg returns as a
// STRING, so each aggregate is cast ::text and routed through parseBigIntSafe (rule 10);
// there is no raw Number() on an aggregate anywhere in this file. All queries are
// parameterized by Knex (RT-12 - no string interpolation of user input).
import type { Knex } from 'knex'
import { parseBigIntSafe } from '../../db/types'
import { ACCOUNTS } from '../../ledger'
import type { ResolvedPeriod } from '../../reports/period'

/** Inputs shared by every admin metrics query. Admin metrics are global (all providers)
 *  unless `providerId` narrows them (per-provider breakdown + reconciliation). */
export interface MetricsScope {
  period: ResolvedPeriod
  includeSynthetic: boolean
  /** Optional provider filter; when set, every figure is for this provider only. */
  providerId?: string
}

function sumToInt(row: { total: string | number | null } | undefined): number {
  return parseBigIntSafe(row?.total ?? '0')
}

/** Apply the synthetic filter on a column (`alias.is_synthetic`) unless includeSynthetic. */
function applySynthetic(q: Knex.QueryBuilder, scope: MetricsScope, col: string): void {
  if (!scope.includeSynthetic) q.where(col, false)
}

/**
 * Sum of a single ledger account's entries on PAYMENT journals for orders paid in the
 * period. Joined to orders so the period basis is orders.paid_at (docs/METRICS.md).
 */
async function sumPaymentAccount(db: Knex, scope: MetricsScope, account: string): Promise<number> {
  const q = db('ledger_entries as le')
    .join('journals as j', 'j.id', 'le.journal_id')
    .join('orders as o', 'o.id', 'le.order_id')
    .where('le.account', account)
    .where('j.type', 'PAYMENT')
    .where('o.paid_at', '>=', scope.period.startTs)
    .where('o.paid_at', '<', scope.period.endTsExclusive)
  if (scope.providerId) q.where('o.provider_id', scope.providerId)
  applySynthetic(q, scope, 'le.is_synthetic')
  const row = await q
    .select(db.raw('coalesce(sum(le.amount_cents), 0)::text as total'))
    .first<{ total: string }>()
  return sumToInt(row)
}

/** Total GMV: sum of PAYMENT CASH_CLEARING debits for orders paid in the period. */
export function queryGmvCents(db: Knex, scope: MetricsScope): Promise<number> {
  return sumPaymentAccount(db, scope, ACCOUNTS.CASH_CLEARING)
}

/** Platform fee revenue: -(sum of PLATFORM_FEE_REVENUE), retained even on refunds. */
export async function queryPlatformFeeCents(db: Knex, scope: MetricsScope): Promise<number> {
  return -(await sumPaymentAccount(db, scope, ACCOUNTS.PLATFORM_FEE_REVENUE))
}

/** Recurring GMV: Total GMV restricted to recurring_cycle orders paid in the period. */
export async function queryRecurringGmvCents(db: Knex, scope: MetricsScope): Promise<number> {
  const q = db('ledger_entries as le')
    .join('journals as j', 'j.id', 'le.journal_id')
    .join('orders as o', 'o.id', 'le.order_id')
    .where('le.account', ACCOUNTS.CASH_CLEARING)
    .where('j.type', 'PAYMENT')
    .where('o.kind', 'recurring_cycle')
    .where('o.paid_at', '>=', scope.period.startTs)
    .where('o.paid_at', '<', scope.period.endTsExclusive)
  if (scope.providerId) q.where('o.provider_id', scope.providerId)
  applySynthetic(q, scope, 'le.is_synthetic')
  const row = await q
    .select(db.raw('coalesce(sum(le.amount_cents), 0)::text as total'))
    .first<{ total: string }>()
  return sumToInt(row)
}

/** Refunded GMV: sum of refunds.amount_cents whose refund created_at is in the period. */
export async function queryRefundedGmvCents(db: Knex, scope: MetricsScope): Promise<number> {
  const q = db('refunds as r')
    .join('orders as o', 'o.id', 'r.order_id')
    .where('r.created_at', '>=', scope.period.startTs)
    .where('r.created_at', '<', scope.period.endTsExclusive)
  if (scope.providerId) q.where('o.provider_id', scope.providerId)
  applySynthetic(q, scope, 'r.is_synthetic')
  const row = await q
    .select(db.raw('coalesce(sum(r.amount_cents), 0)::text as total'))
    .first<{ total: string }>()
  return sumToInt(row)
}

/** Sunk fees on refunded GMV: sum of refunds.fee_retained_cents in the period. */
export async function querySunkFeeCents(db: Knex, scope: MetricsScope): Promise<number> {
  const q = db('refunds as r')
    .join('orders as o', 'o.id', 'r.order_id')
    .where('r.created_at', '>=', scope.period.startTs)
    .where('r.created_at', '<', scope.period.endTsExclusive)
  if (scope.providerId) q.where('o.provider_id', scope.providerId)
  applySynthetic(q, scope, 'r.is_synthetic')
  const row = await q
    .select(db.raw('coalesce(sum(r.fee_retained_cents), 0)::text as total'))
    .first<{ total: string }>()
  return sumToInt(row)
}

/** Provider net margin from settled sales: sum(orders.margin_cents) over orders paid in
 *  the period and NOT refunded (no refund row) - docs/METRICS.md. */
export async function queryProviderNetMarginCents(db: Knex, scope: MetricsScope): Promise<number> {
  const q = db('orders as o')
    .where('o.paid_at', '>=', scope.period.startTs)
    .where('o.paid_at', '<', scope.period.endTsExclusive)
    .whereNotNull('o.margin_cents')
    .whereNotExists(function () {
      this.select('*').from('refunds as r').whereRaw('r.order_id = o.id')
    })
  if (scope.providerId) q.where('o.provider_id', scope.providerId)
  applySynthetic(q, scope, 'o.is_synthetic')
  const row = await q
    .select(db.raw('coalesce(sum(o.margin_cents), 0)::text as total'))
    .first<{ total: string }>()
  return sumToInt(row)
}

/**
 * The providers' own markup on settled sales (ADR-028): sum(qty x unit_markup_cents) and
 * the units it covers, over lines of orders paid in the period and NOT refunded. Lines
 * priced before ADR-028 have no markup and are left out (not counted as $0). Provider net
 * margin from settled sales is always >= this figure; the gap is the price round-up.
 */
export async function queryProviderMarkup(db: Knex, scope: MetricsScope): Promise<{ markupCents: number; units: number }> {
  const q = db('order_lines as ol')
    .join('orders as o', 'o.id', 'ol.order_id')
    .where('o.paid_at', '>=', scope.period.startTs)
    .where('o.paid_at', '<', scope.period.endTsExclusive)
    .whereNotNull('ol.unit_markup_cents')
    .whereNotExists(function () {
      this.select('*').from('refunds as r').whereRaw('r.order_id = o.id')
    })
  if (scope.providerId) q.where('o.provider_id', scope.providerId)
  applySynthetic(q, scope, 'o.is_synthetic')
  const row = await q
    .select(
      db.raw('coalesce(sum(ol.qty::bigint * ol.unit_markup_cents), 0)::text as markup'),
      db.raw('coalesce(sum(ol.qty), 0)::text as units')
    )
    .first<{ markup: string; units: string }>()
  return { markupCents: parseBigIntSafe(row?.markup ?? '0'), units: parseBigIntSafe(row?.units ?? '0') }
}

/** Count of orders paid in the period (includes later-refunded orders; they were paid). */
export async function queryPaidOrderCount(db: Knex, scope: MetricsScope): Promise<number> {
  const q = db('orders as o')
    .where('o.paid_at', '>=', scope.period.startTs)
    .where('o.paid_at', '<', scope.period.endTsExclusive)
  if (scope.providerId) q.where('o.provider_id', scope.providerId)
  applySynthetic(q, scope, 'o.is_synthetic')
  const row = await q.select(db.raw('count(*)::text as total')).first<{ total: string }>()
  return sumToInt(row)
}

/** The subtotal/cogs of each SETTLED order (paid in period, not refunded) for the
 *  reconciliation check (owner's per-order formula recomputed from raw snapshots). */
export async function querySettledOrderSplits(
  db: Knex,
  scope: MetricsScope
): Promise<Array<{ subtotalCents: number; cogsCents: number }>> {
  const q = db('orders as o')
    .where('o.paid_at', '>=', scope.period.startTs)
    .where('o.paid_at', '<', scope.period.endTsExclusive)
    .whereNotNull('o.subtotal_cents')
    .whereNotNull('o.cogs_cents')
    .whereNotExists(function () {
      this.select('*').from('refunds as r').whereRaw('r.order_id = o.id')
    })
  if (scope.providerId) q.where('o.provider_id', scope.providerId)
  applySynthetic(q, scope, 'o.is_synthetic')
  const rows = await q.select(
    db.raw('o.subtotal_cents::text as subtotal'),
    db.raw('o.cogs_cents::text as cogs')
  )
  return rows.map((r: { subtotal: string; cogs: string }) => ({
    subtotalCents: parseBigIntSafe(r.subtotal),
    cogsCents: parseBigIntSafe(r.cogs)
  }))
}

// ---- Migration off third-party marketplaces (docs/METRICS.md "Leading indicator") ----

/** Per-provider baseline: total gmv and distinct months covered, in the synthetic scope. */
export async function queryBaselineByProvider(
  db: Knex,
  includeSynthetic: boolean
): Promise<Array<{ providerId: string; totalGmvCents: number; monthsCovered: number }>> {
  const q = db('baseline_orders as b').whereNotNull('b.provider_id')
  if (!includeSynthetic) q.where('b.is_synthetic', false)
  const rows = await q
    .groupBy('b.provider_id')
    .select(
      'b.provider_id as providerId',
      db.raw('coalesce(sum(b.gmv_cents), 0)::text as total'),
      db.raw("count(distinct date_trunc('month', b.order_date))::text as months")
    )
  return rows.map((r: { providerId: string; total: string; months: string }) => ({
    providerId: r.providerId,
    totalGmvCents: parseBigIntSafe(r.total),
    monthsCovered: parseBigIntSafe(r.months)
  }))
}

/** Per-provider in-house Total GMV (CASH_CLEARING PAYMENT) for orders paid in the period. */
export async function queryInHouseGmvByProvider(
  db: Knex,
  scope: MetricsScope
): Promise<Map<string, number>> {
  const q = db('ledger_entries as le')
    .join('journals as j', 'j.id', 'le.journal_id')
    .join('orders as o', 'o.id', 'le.order_id')
    .where('le.account', ACCOUNTS.CASH_CLEARING)
    .where('j.type', 'PAYMENT')
    .where('o.paid_at', '>=', scope.period.startTs)
    .where('o.paid_at', '<', scope.period.endTsExclusive)
    .whereNotNull('o.provider_id')
  applySynthetic(q, scope, 'le.is_synthetic')
  const rows = await q
    .groupBy('o.provider_id')
    .select('o.provider_id as providerId', db.raw('coalesce(sum(le.amount_cents), 0)::text as total'))
  const map = new Map<string, number>()
  for (const r of rows as Array<{ providerId: string; total: string }>) {
    map.set(r.providerId, parseBigIntSafe(r.total))
  }
  return map
}
