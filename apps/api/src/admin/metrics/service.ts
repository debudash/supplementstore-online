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
import { invalidInput, notFound } from '../errors'
import {
  queryGmvCents,
  queryPlatformFeeCents,
  queryRecurringGmvCents,
  queryRefundedGmvCents,
  querySunkFeeCents,
  queryProviderNetMarginCents,
  queryProviderMarkup,
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
 * owner's formula from raw snapshots: subtotal - cogs - orderFee(subtotal), where
 * orderFee is the half-up 0.75% fee. Summed, it must match the recorded ledger figure
 * (provider net margin from settled sales) within 1 cent per order.
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
    settled,
    markup
  ] = await Promise.all([
    queryGmvCents(db, scope),
    queryPlatformFeeCents(db, scope),
    queryRefundedGmvCents(db, scope),
    querySunkFeeCents(db, scope),
    queryProviderNetMarginCents(db, scope),
    queryRecurringGmvCents(db, scope),
    queryPaidOrderCount(db, scope),
    querySettledOrderSplits(db, scope),
    queryProviderMarkup(db, scope)
  ])

  const block: MetricsBlock = {
    gmvCents,
    refundedGmvCents,
    settledGmvCents: gmvCents - refundedGmvCents,
    platformFeeCents,
    sunkFeeCents,
    providerNetMarginCents,
    providerNetAfterSunkFeesCents: providerNetMarginCents - sunkFeeCents,
    providerMarkupCents: markup.markupCents,
    markupUnits: markup.units,
    avgMarkupPerUnitCents: intDiv(markup.markupCents, markup.units),
    orderCount,
    aovCents: intDiv(gmvCents, orderCount),
    recurringGmvCents,
    recurringShareBps: bps(recurringGmvCents, gmvCents)
  }
  return { block, reconciliation: reconcile(settled, providerNetMarginCents) }
}

/**
 * Build the migration-off-marketplaces report (docs/METRICS.md "Leading indicator").
 * Migration is a MONTHLY figure (in-house GMV for a month / baseline monthly GMV), so a
 * multi-month window reports the average month (divide by the months in the window) and
 * a per-month trend - the trend is the leading indicator the report exists to show.
 */
async function computeMigration(
  db: Knex,
  period: ResolvedPeriod,
  includeSynthetic: boolean,
  providerId?: string
): Promise<MigrationReport> {
  const months = monthSubPeriods(period)
  const [baselineRows, ...inHouseByMonth] = await Promise.all([
    queryBaselineByProvider(db, includeSynthetic),
    ...months.map((m) => queryInHouseGmvByProvider(db, { period: m.period, includeSynthetic }))
  ])
  return buildMigrationReport(
    baselineRows.map((b) => ({ providerId: b.providerId, baselineMonthlyGmvCents: intDiv(b.totalGmvCents, b.monthsCovered) })),
    months.map((m, i) => ({ month: m.key, inHouse: inHouseByMonth[i] })),
    providerId
  )
}

/** Assemble the report from each baseline provider's monthly baseline and in-house GMV per month. */
function buildMigrationReport(
  baselines: Array<{ providerId: string; baselineMonthlyGmvCents: number }>,
  months: Array<{ month: string; inHouse: Map<string, number> }>,
  onlyProviderId?: string
): MigrationReport {
  const monthCount = months.length
  const scoped = onlyProviderId ? baselines.filter((b) => b.providerId === onlyProviderId) : baselines
  const baselineProviders = new Set(baselines.map((b) => b.providerId))
  const migration = (inHouse: number, baselineMonthly: number, n: number): number | null =>
    baselineMonthly > 0 ? bps(inHouse, baselineMonthly * n) : null

  const providers: MigrationProviderRow[] = scoped.map((b) => {
    const byMonth = months.map((m) => {
      const inHouseGmvCents = m.inHouse.get(b.providerId) ?? 0
      return { month: m.month, inHouseGmvCents, migrationBps: migration(inHouseGmvCents, b.baselineMonthlyGmvCents, 1) }
    })
    const inHouseGmvCents = byMonth.reduce((a, m) => a + m.inHouseGmvCents, 0)
    return {
      providerId: b.providerId,
      baselineMonthlyGmvCents: b.baselineMonthlyGmvCents,
      inHouseGmvCents,
      migrationBps: migration(inHouseGmvCents, b.baselineMonthlyGmvCents, monthCount),
      adopted: inHouseGmvCents > 0,
      byMonth
    }
  })
  providers.sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0))

  const overallBaselineMonthlyGmvCents = providers.reduce((a, p) => a + p.baselineMonthlyGmvCents, 0)
  const overallInHouseGmvCents = providers.reduce((a, p) => a + p.inHouseGmvCents, 0)
  const byMonth = months.map((m, i) => {
    const inHouseGmvCents = providers.reduce((a, p) => a + p.byMonth[i].inHouseGmvCents, 0)
    return { month: m.month, inHouseGmvCents, migrationBps: migration(inHouseGmvCents, overallBaselineMonthlyGmvCents, 1) }
  })

  const withActivity = new Set(months.flatMap((m) => [...m.inHouse.entries()].filter(([, v]) => v > 0).map(([k]) => k)))
  const noBaselineProviderIds = [...withActivity]
    .filter((pid) => !baselineProviders.has(pid) && (!onlyProviderId || pid === onlyProviderId))
    .sort()

  return {
    providers,
    overallInHouseGmvCents,
    overallBaselineMonthlyGmvCents,
    months: monthCount,
    overallMigrationBps: migration(overallInHouseGmvCents, overallBaselineMonthlyGmvCents, monthCount),
    byMonth,
    adoptionBps: providers.length > 0 ? bps(providers.filter((p) => p.adopted).length, providers.length) : null,
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
  /** Scope the whole report (headline, reconciliation, migration, groups) to one provider. */
  providerId?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** GET /api/admin/providers - every provider with its practice, ordered by name. */
export async function listProviders(
  db: Knex
): Promise<Array<{ id: string; name: string; practiceId: string; practiceName: string | null }>> {
  const rows: Array<{ id: string; name: string; practice_id: string; practice_name: string | null }> = await db('providers as pv')
    .leftJoin('practices as pc', 'pc.id', 'pv.practice_id')
    .orderBy([{ column: 'pv.name' }, { column: 'pv.id' }])
    .select('pv.id', 'pv.name', 'pv.practice_id', 'pc.name as practice_name')
  return rows.map((r) => ({ id: r.id, name: r.name, practiceId: r.practice_id, practiceName: r.practice_name }))
}

/** Validate a provider filter: a UUID of an existing provider (404 otherwise). */
async function resolveProviderFilter(db: Knex, providerId: string | undefined): Promise<string | null> {
  if (providerId === undefined) return null
  if (!UUID_RE.test(providerId)) throw invalidInput('providerId must be a provider id (uuid)', { field: 'providerId' })
  const exists = await db('providers').where({ id: providerId }).first('id')
  if (!exists) throw notFound('No such provider', { providerId })
  return providerId
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
  const providerId = await resolveProviderFilter(db, opts.providerId)
  const scope: MetricsScope = providerId ? { period, includeSynthetic, providerId } : { period, includeSynthetic }

  const [{ block: headline, reconciliation }, migration] = await Promise.all([
    computeBlock(db, scope),
    computeMigration(db, period, includeSynthetic, providerId ?? undefined)
  ])

  const groups: MetricsGroup[] = []
  if (groupBy === 'month') {
    for (const sub of monthSubPeriods(period)) {
      const subScope: MetricsScope = providerId
        ? { period: sub.period, includeSynthetic, providerId }
        : { period: sub.period, includeSynthetic }
      const { block, reconciliation: rec } = await computeBlock(db, subScope)
      groups.push({ key: sub.key, block, reconciliation: rec })
    }
  } else if (groupBy === 'provider') {
    const providerIds = providerId ? [providerId] : await providersInScope(db, period, includeSynthetic)
    for (const providerId of providerIds) {
      const { block, reconciliation: rec } = await computeBlock(db, { period, includeSynthetic, providerId })
      groups.push({ key: providerId, block, reconciliation: rec })
    }
  }

  // Display names for every provider id referenced in this response (additive lookup map,
  // so existing shapes are unchanged): migration rows, the no-baseline list, and groups.
  const ids = new Set<string>([
    ...(providerId ? [providerId] : []),
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
    providerId,
    headline,
    reconciliation,
    migration,
    groups,
    providerNames
  }
}
