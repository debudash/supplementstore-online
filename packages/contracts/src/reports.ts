// @cerbo/contracts - provider report + admin payable-statement types (T8).
//
// FR-10 (provider sales dashboard) and FR-11 (provider payable report + Cerbo Admin
// month close). Every money figure here is integer cents and ORIGINATES IN THE LEDGER
// (AGENTS.md money rule 2, FR-10 AC2): the API reads ledger_entries / refunds and does
// no split math. These are the canonical shapes the web client (T8 views) consumes.
//
// Periods are UTC calendar boundaries (NFR-6). A range is expressed as two inclusive
// calendar dates (YYYY-MM-DD); the server treats it internally as the half-open
// timestamptz interval [from 00:00Z, (to + 1 day) 00:00Z).

/** The resolved reporting window echoed back on every report (UTC, inclusive dates). */
export interface ReportPeriod {
  /** Inclusive start date, YYYY-MM-DD (UTC). */
  from: string
  /** Inclusive end date, YYYY-MM-DD (UTC). */
  to: string
}

/** One SKU's sold-unit count in the period (FR-10 AC1). */
export interface UnitsBySku {
  sku: string
  name: string
  units: number
}

/** One status bucket's order count in the period (FR-10 AC1). */
export interface OrdersByStatus {
  status: string
  count: number
}

/**
 * GET /api/reports/sales - the provider sales dashboard (FR-10).
 * All money figures come from ledger entries and refunds for THIS provider only.
 */
export interface SalesReport {
  period: ReportPeriod
  providerId: string
  /** Provider's orders in the period, grouped by current status. */
  ordersByStatus: OrdersByStatus[]
  /** Units sold per SKU on the provider's orders paid in the period. */
  unitsBySku: UnitsBySku[]
  /** Total GMV: sum of PAYMENT CASH_CLEARING debits in the period. */
  gmvCents: number
  /** Refunded GMV: sum of refunds.amount_cents in the period. */
  refundedGmvCents: number
  /** Settled GMV = GMV - refunded GMV. */
  settledGmvCents: number
  /** Platform fee revenue: -(sum of PLATFORM_FEE_REVENUE), including retained fees. */
  platformFeeCents: number
  /** Provider net margin from settled sales: margins on orders paid-and-not-refunded. */
  providerNetMarginCents: number
  /** Whether synthetic demo rows were included (default false). */
  includeSynthetic: boolean
}

/** One order's net contribution to the payable movement in the period (FR-11 AC2). */
export interface PayableContributingOrder {
  orderId: string
  /** Margins credited to the provider in the period for this order. */
  creditsCents: number
  /** Margin reversals + fee retentions debited in the period for this order. */
  debitsCents: number
  /** creditsCents - debitsCents. */
  netCents: number
}

/**
 * GET /api/reports/payables - the provider payable report (FR-11).
 * Monthly by default; any custom range on demand (FR-11 AC1). Balances are derived
 * from PROVIDER_PAYABLE ledger entries: owed = -(sum of PROVIDER_PAYABLE).
 */
export interface PayableReport {
  period: ReportPeriod
  providerId: string
  /** Payable balance carried into the period (sum of prior PROVIDER_PAYABLE, negated). */
  openingCents: number
  /** Margins earned in the period (credits to the provider). */
  creditsCents: number
  /** Margin reversals and fee retentions in the period (debits). */
  debitsCents: number
  /** openingCents + creditsCents - debitsCents. */
  closingCents: number
  /** Orders that moved the balance in the period. */
  contributingOrders: PayableContributingOrder[]
  includeSynthetic: boolean
}

/**
 * An immutable payable statement (FR-11 AC3, ADR-016). Created by a Cerbo Admin month
 * close; the DB rejects UPDATE and DELETE on these rows forever. Aggregates are stored
 * as bigint and surfaced here as safe integers.
 */
export interface PayableStatement {
  id: string
  providerId: string
  practiceId: string
  /** First day of the closed month, YYYY-MM-DD (UTC). */
  periodStart: string
  /** Last day of the closed month, YYYY-MM-DD (UTC). */
  periodEnd: string
  openingCents: number
  creditsCents: number
  debitsCents: number
  closingCents: number
  closedAt: string
  closedBy: string | null
}

/** POST /api/admin/payables/close request body (FR-11 AC3). */
export interface ClosePayablesRequest {
  /** Month to close, "YYYY-MM" (UTC calendar month). */
  month: string
}

/** POST /api/admin/payables/close result: one immutable statement per active provider. */
export interface ClosePayablesResult {
  month: string
  periodStart: string
  periodEnd: string
  statements: PayableStatement[]
}

/**
 * GET /api/admin/payables?month= result. If the month is closed, `closed` is true and
 * `statements` are the stored immutable rows; otherwise they are a live preview computed
 * from the ledger (not yet persisted).
 */
export interface AdminPayablesResponse {
  month: string
  periodStart: string
  periodEnd: string
  closed: boolean
  statements: PayableStatement[]
}
