// Ledger account constants (docs/ARCHITECTURE.md section 5, ADR-007).
//
// Double-entry, posted PER LINE. Sign convention: debit positive, credit negative.
// Every journal sums to zero (money rule 7), enforced at COMMIT by the deferred
// constraint trigger T2 installed on ledger_entries.
export const ACCOUNTS = {
  /** Patient cash in: debited the line total on PAYMENT. */
  CASH_CLEARING: 'CASH_CLEARING',
  /** Cerbo's cost recovery: credited the line COGS on PAYMENT. */
  COGS_RECOVERY: 'COGS_RECOVERY',
  /** What Cerbo owes the provider: credited the line margin on PAYMENT. */
  PROVIDER_PAYABLE: 'PROVIDER_PAYABLE',
  /** Cerbo's platform fee revenue: credited the line fee on PAYMENT. */
  PLATFORM_FEE_REVENUE: 'PLATFORM_FEE_REVENUE'
} as const

export type LedgerAccount = (typeof ACCOUNTS)[keyof typeof ACCOUNTS]
