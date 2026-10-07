// Cerbo Admin metrics service (T10) - FR-13, docs/METRICS.md, ADR-015.
//
// Composes the aggregate queries into the @cerbo/contracts AdminMetricsResponse. Unlike
// the provider-scoped reports (T8), these metrics are GLOBAL across all providers; an
// optional provider filter drives the per-provider breakdown and reconciliation.
//
// MONEY: no split math except the reconciliation's use of @cerbo/money.orderFee - the
// owner's per-order formula (ADR-015) recomputed from raw order snapshots and checked
// against the recorded ledger figure. The reconciliation is applied PER ORDER and
// summed; a blended margin % across orders is explicitly NOT used (docs/METRICS.md).
import type { Knex } from 'knex'
import { orderFee } from '@cerbo/money'
import type {
  AdminMetricsResponse,
  MetricsBlock,
  MetricsGroup,
  MetricsGroupBy,
  MigrationProviderRow,
  MigrationReport,
  ReconciliationLine
} from '@cerbo/contracts'
import { resolveReportPeriod, formatDateOnly, type ResolvedPeriod } from '../../reports/period'
import { invalidInput } from '../errors'
import {
  queryGmvCents,
  queryPlatformFeeCents,
  queryRecurringGmvCents,
  queryRefundedGmvCents,
  querySunkFeeCents,
  queryProviderNetMarginCents,
  queryPaidOrderCount,
  querySettledOrderSplits,
  queryBaselineByProvider,
  queryInHouseGmvByProvider,
  type MetricsScope
} from './queries'

/** Integer-only "x / y in basis points" (floor). 0 when the denominator is 0. */
function bps(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.floor((numerator * 10000) / denominator)
}

/** Integer division for AOV and baseline monthly average; 0 when the denominator is 0. */
function intDiv(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.floor(numerator / denominator)
}

/**
 * The reconciliation check (ADR-015, docs/METRICS.md). For each settled order compute the
 * owner's formula from raw snapshots: subtotal x (margin% - 0.0075) = (subtotal - cogs)
 * - subtotal x 0.0075, whose integer realisation of the 0.75% term is orderFee(subtotal)
 * (half-up). Summed, it must match the recorded ledger figure (provider net margin from
 * settled sales) within 1 cent per order.
 */
function reconcile(
  settled: Array<{ subtotalCents: number; cogsCents: number }>,
  ledgerCents: number
): ReconciliationLine {
  let formulaCents = 0
  for (const o of settled) {
    formulaCents += o.subtotalCents - o.cogsCents - orderFee(o.subtotalCents)
  }
  const diffCents = Math.abs(formulaCents - ledgerCents)
  const toleranceCents = settled.length // 1 cent per order
  return { formulaCents, ledgerCents, diffCents, toleranceCents, pass: diffCents <= toleranceCents }
}

/** Compute the headline block + reconciliation for one scope (overall, a month, or a provider). */
async function computeBlock(
  db: Knex,
  scope: MetricsScope
): Promise<{ block: MetricsBlock; reconciliation: ReconciliationLine }> {
  const [
    gmvCents,
    platformFeeCents,
    refundedGmvCents,
    sunkFeeCents,
    providerNetMarginCents,
    recurringGmvCents,
    orderCount,
    settled
  ] = await Promise.all([
    queryGmvCents(db, scope),
    queryPlatformFeeCents(db, scope),
    queryRefundedGmvCents(db, scope),
    querySunkFeeCents(db, scope),
    queryProviderNetMarginCents(db, scope),
    queryRecurringGmvCents(db, scope),
    queryPaidOrderCount(db, scope),
    querySettledOrderSplits(db, scope)
  ])

  const block: MetricsBlock = {
    gmvCents,
    refundedGmvCents,
    settledGmvCents: gmvCents - refundedGmvCents,
    platformFeeCents,
    sunkFeeCents,
    providerNetMarginCents,
    providerNetAfterSunkFeesCents: providerNetMarginCents - sunkFeeCents,
    orderCount,
    aovCents: intDiv(gmvCents, orderCount),
    recurringGmvCents,
    recurringShareBps: bps(recurringGmvCents, gmvCents)
  }
  return { block, reconciliation: reconcile(settled, providerNetMarginCents) }
}

/** Build the migration-off-marketplaces report (docs/METRICS.md "Leading indicator"). */
async function computeMigration(db: Knex, period: ResolvedPeriod, includeSynthetic: boolean): Promise<MigrationReport> {
  const scope: MetricsScope = { period, includeSynthetic }
  const [baselineRows, inHouseByProvider] = await Promise.all([
    queryBaselineByProvider(db, includeSynthetic),
    queryInHouseGmvByProvider(db, scope)
  ])

  const baselineProviders = new Set(baselineRows.map((b) => b.providerId))
  const providers: MigrationProviderRow[] = []
  let overallInHouseGmvCents = 0
  let overallBaselineMonthlyGmvCents = 0
  let adoptedCount = 0

  for (const b of baselineRows) {
    const baselineMonthlyGmvCents = intDiv(b.totalGmvCents, b.monthsCovered)
    const inHouseGmvCents = inHouseByProvider.get(b.providerId) ?? 0
    const adopted = inHouseGmvCents > 0
    if (adopted) adoptedCount += 1
    overallInHouseGmvCents += inHouseGmvCents
    overallBaselineMonthlyGmvCents += baselineMonthlyGmvCents
    providers.push({
      providerId: b.providerId,
      baselineMonthlyGmvCents,
      inHouseGmvCents,
      migrationBps: baselineMonthlyGmvCents > 0 ? bps(inHouseGmvCents, baselineMonthlyGmvCents) : null,
      adopted
    })
  }
  providers.sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0))

  const noBaselineProviderIds = [...inHouseByProvider.keys()]
    .filter((pid) => !baselineProviders.has(pid))
    .sort()

  return {
    providers,
    overallInHouseGmvCents,
    overallBaselineMonthlyGmvCents,
    overallMigrationBps:
      overallBaselineMonthlyGmvCents > 0 ? bps(overallInHouseGmvCents, overallBaselineMonthlyGmvCents) : null,
    adoptionBps: baselineProviders.size > 0 ? bps(adoptedCount, baselineProviders.size) : null,
    noBaselineProviderIds
  }
}

/** Enumerate the UTC calendar months overlapping [period], each clipped to the window. */
function monthSubPeriods(period: ResolvedPeriod): Array<{ key: string; period: ResolvedPeriod }> {
  const out: Array<{ key: string; period: ResolvedPeriod }> = []
  const start = period.startTs
  let y = start.getUTCFullYear()
  let m = start.getUTCMonth() // 0-based
  // Walk month by month until the month start passes the exclusive end.
  while (true) {
    const monthStart = new Date(Date.UTC(y, m, 1))
    if (monthStart.getTime() >= period.endTsExclusive.getTime()) break
    const monthEndExclusive = new Date(Date.UTC(y, m + 1, 1))
    // Clip to the requested window.
    const startTs = monthStart.getTime() < period.startTs.getTime() ? period.startTs : monthStart
    const endTsExclusive =
      monthEndExclusive.getTime() > period.endTsExclusive.getTime() ? period.endTsExclusive : monthEndExclusive
    const lastDay = new Date(endTsExclusive.getTime() - 24 * 60 * 60 * 1000)
    const key = `${y}-${String(m + 1).padStart(2, '0')}`
    out.push({
      key,
      period: { from: formatDateOnly(startTs), to: formatDateOnly(lastDay), startTs, endTsExclusive }
    })
    m += 1
    if (m > 11) {
      m = 0
      y += 1
    }
  }
  return out
}

/** Distinct providers in scope for a per-provider breakdown: any with in-house GMV or a baseline. */
async function providersInScope(db: Knex, period: ResolvedPeriod, includeSynthetic: boolean): Promise<string[]> {
  const [inHouse, baseline] = await Promise.all([
    queryInHouseGmvByProvider(db, { period, includeSynthetic }),
    queryBaselineByProvider(db, includeSynthetic)
  ])
  const set = new Set<string>([...inHouse.keys(), ...baseline.map((b) => b.providerId)])
  return [...set].sort()
}

export interface AdminMetricsOpts {
  from?: string
  to?: string
  groupBy?: string
  includeSynthetic?: boolean
}

/** Parse and validate the groupBy query value. */
function parseGroupBy(value: string | undefined): MetricsGroupBy {
  if (value === undefined || value === '' || value === 'none') return 'none'
  if (value === 'month' || value === 'provider') return value
  throw invalidInput('groupBy must be one of none|month|provider', { field: 'groupBy', value })
}

/** GET /api/admin/metrics - the Cerbo Admin metrics + migration report (FR-13). */
export async function getAdminMetrics(db: Knex, opts: AdminMetricsOpts): Promise<AdminMetricsResponse> {
  const period = resolveReportPeriod(opts.from, opts.to)
  const includeSynthetic = opts.includeSynthetic ?? false
  const groupBy = parseGroupBy(opts.groupBy)
  const scope: MetricsScope = { period, includeSynthetic }

  const [{ block: headline, reconciliation }, migration] = await Promise.all([
    computeBlock(db, scope),
    computeMigration(db, period, includeSynthetic)
  ])

  const groups: MetricsGroup[] = []
  if (groupBy === 'month') {
    for (const sub of monthSubPeriods(period)) {
      const { block, reconciliation: rec } = await computeBlock(db, { period: sub.period, includeSynthetic })
      groups.push({ key: sub.key, block, reconciliation: rec })
    }
  } else if (groupBy === 'provider') {
    const providerIds = await providersInScope(db, period, includeSynthetic)
    for (const providerId of providerIds) {
      const { block, reconciliation: rec } = await computeBlock(db, { period, includeSynthetic, providerId })
      groups.push({ key: providerId, block, reconciliation: rec })
    }
  }

  // Display names for every provider id referenced in this response (additive lookup map,
  // so existing shapes are unchanged): migration rows, the no-baseline list, and groups.
  const ids = new Set<string>([
    ...migration.providers.map((p) => p.providerId),
    ...migration.noBaselineProviderIds,
    ...(groupBy === 'provider' ? groups.map((g) => g.key) : [])
  ])
  const providerNames: Record<string, { providerName: string | null; practiceName: string | null }> = {}
  if (ids.size > 0) {
    const rows: Array<{ id: string; provider_name: string | null; practice_name: string | null }> = await db('providers as pv')
      .leftJoin('practices as pc', 'pc.id', 'pv.practice_id')
      .whereIn('pv.id', [...ids])
      .select('pv.id', 'pv.name as provider_name', 'pc.name as practice_name')
    for (const r of rows) providerNames[r.id] = { providerName: r.provider_name, practiceName: r.practice_name }
  }

  return {
    period: { from: period.from, to: period.to },
    includeSynthetic,
    groupBy,
    headline,
    reconciliation,
    migration,
    groups,
    providerNames
  }
}
