// Reports service (T8) - FR-10 (provider sales dashboard), FR-11 (provider payable
// report + Cerbo Admin month close). The service composes the aggregate queries in
// queries.ts into the @cerbo/contracts shapes. No split math here (money rule 2): the
// ledger is the record, these functions report it.
import type { Knex } from 'knex'
import type {
  SalesReport,
  PayableReport,
  PayableStatement,
  ClosePayablesResult,
  AdminPayablesResponse
} from '@cerbo/contracts'
import { parseBigIntSafe } from '../db/types'
import { alreadyClosed } from './errors'
import { resolveReportPeriod, resolveMonth, type ResolvedPeriod } from './period'
import {
  queryGmvCents,
  queryPlatformFeeCents,
  queryRefundedGmvCents,
  queryProviderNetMarginCents,
  queryUnitsBySku,
  queryOrdersByStatus,
  queryPayableBalanceBefore,
  queryPayableMovement,
  queryPayableContributingOrders,
  queryProvidersWithPayableActivity,
  type ReportScope
} from './queries'

/** GET /api/reports/sales - provider sales dashboard (FR-10). Provider-scoped. */
export async function getSalesReport(
  db: Knex,
  providerId: string,
  opts: { from?: string; to?: string; includeSynthetic?: boolean }
): Promise<SalesReport> {
  const period = resolveReportPeriod(opts.from, opts.to)
  const includeSynthetic = opts.includeSynthetic ?? false
  const scope: ReportScope = { providerId, period, includeSynthetic }

  const [gmvCents, platformFeeCents, refundedGmvCents, providerNetMarginCents, unitsBySku, ordersByStatus] =
    await Promise.all([
      queryGmvCents(db, scope),
      queryPlatformFeeCents(db, scope),
      queryRefundedGmvCents(db, scope),
      queryProviderNetMarginCents(db, scope),
      queryUnitsBySku(db, scope),
      queryOrdersByStatus(db, scope)
    ])

  return {
    period: { from: period.from, to: period.to },
    providerId,
    ordersByStatus,
    unitsBySku,
    gmvCents,
    refundedGmvCents,
    settledGmvCents: gmvCents - refundedGmvCents,
    platformFeeCents,
    providerNetMarginCents,
    includeSynthetic
  }
}

/** GET /api/reports/payables - provider payable report (FR-11). Provider-scoped. */
export async function getPayableReport(
  db: Knex,
  providerId: string,
  opts: { from?: string; to?: string; includeSynthetic?: boolean }
): Promise<PayableReport> {
  const period = resolveReportPeriod(opts.from, opts.to)
  const includeSynthetic = opts.includeSynthetic ?? false
  const scope: ReportScope = { providerId, period, includeSynthetic }

  const [openingCents, movement, contributingOrders] = await Promise.all([
    queryPayableBalanceBefore(db, providerId, period.startTs, includeSynthetic),
    queryPayableMovement(db, scope),
    queryPayableContributingOrders(db, scope)
  ])

  return {
    period: { from: period.from, to: period.to },
    providerId,
    openingCents,
    creditsCents: movement.creditsCents,
    debitsCents: movement.debitsCents,
    closingCents: openingCents + movement.creditsCents - movement.debitsCents,
    contributingOrders,
    includeSynthetic
  }
}

interface StatementRow {
  id: string
  provider_id: string
  practice_id: string
  period_start: string
  period_end: string
  opening_cents: string | number
  credits_cents: string | number
  debits_cents: string | number
  closing_cents: string | number
  closed_at: Date | string
  closed_by: string | null
}

/** Map a payable_statements DB row to the contract shape (bigint cents -> safe int). */
function toStatement(r: StatementRow): PayableStatement {
  return {
    id: r.id,
    providerId: r.provider_id,
    practiceId: r.practice_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    openingCents: parseBigIntSafe(r.opening_cents),
    creditsCents: parseBigIntSafe(r.credits_cents),
    debitsCents: parseBigIntSafe(r.debits_cents),
    closingCents: parseBigIntSafe(r.closing_cents),
    closedAt: new Date(r.closed_at).toISOString(),
    closedBy: r.closed_by
  }
}

/** Select statement columns with dates as text so pg date parsing never shifts them. */
function selectStatements(db: Knex) {
  return db('payable_statements').select(
    'id',
    'provider_id',
    'practice_id',
    db.raw(`to_char(period_start, 'YYYY-MM-DD') as period_start`),
    db.raw(`to_char(period_end, 'YYYY-MM-DD') as period_end`),
    'opening_cents',
    'credits_cents',
    'debits_cents',
    'closing_cents',
    'closed_at',
    'closed_by'
  )
}

/**
 * Compute a provider's opening/credits/debits/closing for a period, from REAL ledger
 * entries only (statements are payout artifacts; synthetic demo data is never paid out).
 */
async function computeStatementFigures(
  db: Knex,
  providerId: string,
  period: ResolvedPeriod
): Promise<{ openingCents: number; creditsCents: number; debitsCents: number; closingCents: number }> {
  const scope: ReportScope = { providerId, period, includeSynthetic: false }
  const [openingCents, movement] = await Promise.all([
    queryPayableBalanceBefore(db, providerId, period.startTs, false),
    queryPayableMovement(db, scope)
  ])
  return {
    openingCents,
    creditsCents: movement.creditsCents,
    debitsCents: movement.debitsCents,
    closingCents: openingCents + movement.creditsCents - movement.debitsCents
  }
}

/**
 * POST /api/admin/payables/close - close a UTC month into immutable payable_statements,
 * one per provider with payable activity (FR-11 AC3, ADR-016). Rejects if any statement
 * already exists for that month (unique (provider_id, period_start)); ALREADY_CLOSED.
 * The whole close runs in one transaction so a partial close never persists.
 */
export async function closePayables(
  db: Knex,
  closedBy: string,
  month: string
): Promise<ClosePayablesResult> {
  const period = resolveMonth(month)

  return db.transaction(async (trx) => {
    const providers = await queryProvidersWithPayableActivity(trx, period.endTsExclusive)

    // Pre-check: a clean ALREADY_CLOSED rather than a raw unique-violation. The unique
    // constraint still backstops a race (two concurrent closes).
    const existing = await trx('payable_statements')
      .where('period_start', period.from)
      .select('provider_id')
    if (existing.length > 0) {
      throw alreadyClosed(month, existing.map((e: { provider_id: string }) => e.provider_id))
    }

    const inserted: PayableStatement[] = []
    for (const p of providers) {
      const figures = await computeStatementFigures(trx, p.providerId, period)
      const [row] = await trx('payable_statements')
        .insert({
          provider_id: p.providerId,
          practice_id: p.practiceId,
          period_start: period.from,
          period_end: period.to,
          opening_cents: figures.openingCents,
          credits_cents: figures.creditsCents,
          debits_cents: figures.debitsCents,
          closing_cents: figures.closingCents,
          closed_by: closedBy
        })
        .returning<StatementRow[]>([
          'id',
          'provider_id',
          'practice_id',
          trx.raw(`to_char(period_start, 'YYYY-MM-DD') as period_start`),
          trx.raw(`to_char(period_end, 'YYYY-MM-DD') as period_end`),
          'opening_cents',
          'credits_cents',
          'debits_cents',
          'closing_cents',
          'closed_at',
          'closed_by'
        ])
      inserted.push(toStatement(row))
    }

    return { month, periodStart: period.from, periodEnd: period.to, statements: inserted }
  })
}

/**
 * GET /api/admin/payables?month= - if the month is closed, return the stored immutable
 * statements; otherwise a live preview computed from the ledger (not persisted).
 */
export async function getAdminPayables(db: Knex, month: string): Promise<AdminPayablesResponse> {
  const period = resolveMonth(month)

  const stored = (await selectStatements(db)
    .where('period_start', period.from)
    .orderBy('provider_id')) as StatementRow[]

  if (stored.length > 0) {
    return {
      month,
      periodStart: period.from,
      periodEnd: period.to,
      closed: true,
      statements: stored.map(toStatement)
    }
  }

  // Live preview: what a close would produce right now.
  const providers = await queryProvidersWithPayableActivity(db, period.endTsExclusive)
  const statements: PayableStatement[] = []
  for (const p of providers) {
    const figures = await computeStatementFigures(db, p.providerId, period)
    statements.push({
      id: '',
      providerId: p.providerId,
      practiceId: p.practiceId,
      periodStart: period.from,
      periodEnd: period.to,
      openingCents: figures.openingCents,
      creditsCents: figures.creditsCents,
      debitsCents: figures.debitsCents,
      closingCents: figures.closingCents,
      closedAt: '',
      closedBy: null
    })
  }
  return { month, periodStart: period.from, periodEnd: period.to, closed: false, statements }
}
