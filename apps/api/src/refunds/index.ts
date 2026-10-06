// Refunds module (T5): whole-order refund service and the REFUND journal posting
// (FR-8). The posting is the GATE G4 deliverable. The ledger stays append-only - a
// refund is a NEW journal, never an update of the PAYMENT journal (money rule 6).
//
// Route wiring lives in T3's provider order router and T11's admin operations router;
// they import refundOrder from here. This module owns the business logic and tests.
export { refundOrder } from './service'
export { postRefundJournal, MEMO_MARGIN_REVERSAL, MEMO_FEE_RETENTION } from './posting'
export type { PostRefundJournalInput, RefundPostingLine, RefundPostingOrder } from './posting'
export { RefundError, handleRefundError } from './errors'
