// Ledger module (T4): account constants, the per-line PAYMENT posting function, and
// the read-only audit query. The ledger is append-only (money rule 6); nothing here
// updates or deletes journals or ledger_entries.
export { ACCOUNTS } from './accounts'
export type { LedgerAccount } from './accounts'
export { postPaymentJournal } from './post'
export type { PostPaymentJournalInput, PostingLine, PostingOrder } from './post'
export { loadAudit } from './audit'
export type { AuditResponse } from './types'
