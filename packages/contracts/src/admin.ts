// @cerbo/contracts - Cerbo Admin metrics, baseline import, and demo-data types (T10).
//
// FR-13 (admin metrics + migration report) and FR-14 (baseline + demo data). Every
// money figure is integer cents and ORIGINATES IN THE LEDGER / refunds / baseline
// tables (AGENTS.md money rule 2, ADR-015): this module aggregates recorded rows and
// never recomputes a fee, allocation, or margin.
//
// Percentages are never floats (money rule 1). A percent is carried as an integer in
// basis points (bps, 1% = 100 bps) alongside the raw cents it was derived from, so the
// web client can render it without the API ever doing float math on money.
//
// Period semantics match @cerbo/contracts reports.ts: a window is two inclusive UTC
// calendar dates; the basis for payment events is orders.paid_at and for refund events
// refunds.created_at (docs/METRICS.md).

import type { ReportPeriod } from './reports'

/** How the admin metrics are broken out (docs/ARCHITECTURE.md section 8). */
export type MetricsGroupBy = 'none' | 'month' | 'provider'

/**
 * The headline + provider-economics block for a scope (overall, a month, or a provider).
 * Every field is docs/METRICS.md "Headline" and "Provider economics", integer cents.
 */
export interface MetricsBlock {
  /** Total GMV: sum of PAYMENT CASH_CLEARING debits for orders paid in the period. */
  gmvCents: number
  /** Refunded GMV: sum of refunds.amount_cents in the period. */
  refundedGmvCents: number
  /** Settled GMV = Total GMV - Refunded GMV. */
  settledGmvCents: number
  /** Platform fee revenue: -(sum PLATFORM_FEE_REVENUE), includes fees on refunded orders. */
  platformFeeCents: number
  /** Sunk fees on refunded GMV: sum of refunds.fee_retained_cents in the period. */
  sunkFeeCents: number
  /** Provider net margin from settled sales: margins on orders paid-and-not-refunded. */
  providerNetMarginCents: number
  /** Provider net after sunk fees = providerNetMargin - sunkFees. */
  providerNetAfterSunkFeesCents: number
  /** Paid orders in the period. */
  orderCount: number
  /** Average order value = Total GMV / order count (integer division, display only). */
  aovCents: number
  /** GMV from recurring_cycle orders paid in the period. */
  recurringGmvCents: number
  /** Recurring share = recurringGmv / Total GMV, in basis points (0 when no GMV). */
  recurringShareBps: number
}

/**
 * The reconciliation check (docs/METRICS.md "Reconciliation check", ADR-015). Applied
 * PER ORDER and summed - never a blended margin % across orders. `formulaCents` is the
 * owner's per-order formula summed; `ledgerCents` is the figure read from the ledger.
 * They must agree within 1 cent per order (`toleranceCents` = order count).
 */
export interface ReconciliationLine {
  /** Sum over settled orders of (subtotal - cogs - orderFee(subtotal)). */
  formulaCents: number
  /** Provider net margin from settled sales, as recorded (PROVIDER_PAYABLE). */
  ledgerCents: number
  /** |formulaCents - ledgerCents|. */
  diffCents: number
  /** Allowed tolerance = 1 cent per settled order. */
  toleranceCents: number
  /** diffCents <= toleranceCents. */
  pass: boolean
}

/** One provider's migration-off-marketplaces figures (docs/METRICS.md "Leading indicator"). */
export interface MigrationProviderRow {
  providerId: string
  /** Baseline monthly GMV = sum(baseline_orders.gmv_cents) / distinct months covered. */
  baselineMonthlyGmvCents: number
  /** In-house Total GMV for this provider in the period. */
  inHouseGmvCents: number
  /**
   * Migration % = in-house GMV / baseline monthly GMV, in basis points. Can exceed
   * 10000 (growth beyond prior external volume). Null when there is no baseline.
   */
  migrationBps: number | null
  /** True when the provider has >= 1 in-house paid order in the period (adoption). */
  adopted: boolean
}

/** The migration-off-marketplaces report (docs/METRICS.md "Leading indicator"). */
export interface MigrationReport {
  /** Providers that have a baseline, with their migration figures. */
  providers: MigrationProviderRow[]
  /** Overall in-house GMV (providers with a baseline) in the period. */
  overallInHouseGmvCents: number
  /** Overall baseline monthly GMV (providers with a baseline). */
  overallBaselineMonthlyGmvCents: number
  /** Overall migration % in bps = overall in-house / overall baseline monthly. Null if no baseline. */
  overallMigrationBps: number | null
  /** Adoption = providers with >= 1 in-house paid order / providers with a baseline, in bps. */
  adoptionBps: number | null
  /** Providers with in-house activity but no baseline, listed separately and excluded. */
  noBaselineProviderIds: string[]
}

/** One group when groupBy is month or provider: the key plus its block + reconciliation. */
export interface MetricsGroup {
  /** "YYYY-MM" when grouped by month, or the provider id when grouped by provider. */
  key: string
  block: MetricsBlock
  reconciliation: ReconciliationLine
}

/**
 * GET /api/admin/metrics?from=&to=&groupBy=month|provider&includeSynthetic=false (FR-13).
 * Global across all providers (admin surface), unlike the provider-scoped reports.
 */
export interface AdminMetricsResponse {
  period: ReportPeriod
  includeSynthetic: boolean
  groupBy: MetricsGroupBy
  /** The provider the whole report is scoped to, or null for all providers. */
  providerId: string | null
  /** The overall figures for the whole scope. */
  headline: MetricsBlock
  /** The overall reconciliation check (pass/fail line shown in the report). */
  reconciliation: ReconciliationLine
  /** The migration-off-marketplaces report. */
  migration: MigrationReport
  /** Per-month or per-provider breakdown; empty when groupBy = none. */
  groups: MetricsGroup[]
  /** Display names for every provider id referenced above (migration rows, the
   *  no-baseline list, provider groups). Ids without a provider row are absent. */
  providerNames: Record<string, { providerName: string | null; practiceName: string | null }>
}

/** POST /api/admin/demo/reset-story: one-click reset to the standard demo story. */
export interface DemoStoryResetResult {
  story: { baselineSeed: number; baselineMonths: number; migrationSeed: number; migrationMonths: number }
  reset: DemoResetResult
  baseline: BaselineRegenerateResult
  migration: MigrationGenerateResult
}

/** GET /api/admin/evidence: live integrity proof, unit economics and refund exposure. */
export interface EvidenceResponse {
  generatedAt: string
  includeSynthetic: boolean
  integrity: {
    journals: { total: number; unbalanced: number }
    orders: { checked: number; passing: number; failing: number; capped: boolean; failures: Array<{ orderId: string; failedChecks: string[] }> }
    stock: { issues: Array<{ sku: string; onHandQty: number; reservedQty: number }> }
    guards: { expected: number; present: number; missing: string[] }
    reconciliation: ReconciliationLine
  }
  unitEconomics: {
    assumptions: { processingRateBps: number; processingFixedCents: number; platformFeeBps: number }
    orderCount: number
    gmvCents: number
    platformFeeCents: number
    processingCostCents: number
    cerboNetCents: number
    perOrder: { aovCents: number; platformFeeCents: number; processingCostCents: number; cerboNetCents: number }
    breakevenFeeBps: number | null
  }
  refundExposure: {
    refundCount: number
    paidOrderCount: number
    refundRateBps: number | null
    refundedCents: number
    feeRetainedCents: number
    cogsWrittenOffCents: number
    restockedCount: number
    writtenOffCount: number
    byReason: Array<{ reasonCode: string; count: number; amountCents: number }>
    cerboNetAfterWriteoffsCents: number
  }
}

/** GET /api/admin/providers: every provider with its practice (metrics filter). */
export interface AdminProviderListItem {
  id: string
  name: string
  practiceId: string
  practiceName: string | null
}

/** One rejected CSV row (RT-12): the 1-based row number, the raw line, and why. */
export interface BaselineImportRejectedRow {
  row: number
  raw: string
  reason: string
}

/**
 * POST /api/admin/baseline/import result (FR-14 AC1). The CSV (header
 * `provider_email,order_date,gmv_cents,source`) is validated ROW BY ROW; valid rows are
 * inserted under one import_batch_id, bad rows are reported and NOT inserted (RT-12).
 */
export interface BaselineImportResult {
  importBatchId: string
  /** Rows accepted and inserted. */
  insertedCount: number
  /** Rows rejected with a reason; never inserted. */
  rejected: BaselineImportRejectedRow[]
}

/** POST /api/admin/demo/baseline/regenerate result (FR-14 AC2). */
export interface BaselineRegenerateResult {
  importBatchId: string
  seed: number
  months: number
  /** Synthetic baseline rows generated. */
  insertedCount: number
  /** Prior synthetic baseline rows removed first (replace, not append). */
  replacedCount: number
}

/** POST /api/admin/demo/migration/generate result (FR-14 AC3). */
export interface MigrationGenerateResult {
  seed: number
  months: number
  /** Synthetic paid orders generated through the real split + posting code. */
  orderCount: number
  /** Total synthetic in-house GMV generated, integer cents. */
  gmvCents: number
}

/**
 * POST /api/admin/demo/reset result (FR-14 AC4, ADR-019). Purges ONLY is_synthetic rows
 * through the single guarded path; payable_statements are never touched. The counts are
 * the rows removed per table, so a caller can assert synthetic rows are back to zero.
 */
export interface DemoResetResult {
  purged: {
    ledgerEntries: number
    journals: number
    payments: number
    refunds: number
    orderEvents: number
    orderLines: number
    orders: number
    baselineOrders: number
    baselineImports: number
    inventoryMovements: number
  }
}
