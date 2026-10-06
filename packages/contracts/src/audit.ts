// @cerbo/contracts - order audit response types (T4).
//
// FR-7 AC1: GET /api/orders/:id/audit returns the full money record for an order -
// its snapshot, lines, status history, payments, refunds, journals with entries,
// inventory movements, and an explicit invariants block. This is a PROVIDER / Cerbo
// Admin surface (not patient-facing), so it DOES carry full economics.
//
// Refund rows are produced by T5; the audit shape includes them from the start so the
// contract is stable once merged.

/** The order snapshot, with every persisted money field (null until sent). */
export interface AuditOrder {
  id: string
  status: string
  kind: string
  providerId: string
  practiceId: string
  patientId: string
  feeBps: number
  subtotalCents: number | null
  cogsCents: number | null
  feeCents: number | null
  marginCents: number | null
  isSynthetic: boolean
  createdAt: string
  sentAt: string | null
  paidAt: string | null
  fulfilledAt: string | null
  cancelledAt: string | null
  expiredAt: string | null
  refundedAt: string | null
  /** The patient pay token so the audit view can recover the link after send (null for
   * drafts). Provider/Cerbo-Admin surface only; never patient-facing. */
  payToken: string | null
  /** Ready-made pay path, e.g. "/pay/<token>", or null when there is no token. */
  payPath: string | null
}

/** A line with every amount (provider-facing economics). */
export interface AuditLine {
  id: string
  position: number
  sku: string
  name: string
  qty: number
  unitPriceCents: number
  unitCogsCents: number
  lineTotalCents: number | null
  lineCogsCents: number | null
  lineFeeCents: number | null
  lineMarginCents: number | null
}

/** One status transition (order_events). */
export interface AuditEvent {
  fromStatus: string | null
  toStatus: string
  actorUserId: string | null
  at: string
  note: string | null
}

export interface AuditPayment {
  id: string
  idempotencyKey: string
  gatewayRef: string | null
  amountCents: number
  isSynthetic: boolean
  createdAt: string
}

export interface AuditRefund {
  id: string
  reasonCode: string
  amountCents: number
  feeRetainedCents: number
  restocked: boolean
  writeoffCogsCents: number
  gatewayRef: string | null
  actorUserId: string | null
  isSynthetic: boolean
  createdAt: string
}

/** A single signed ledger entry (debit positive). */
export interface AuditLedgerEntry {
  id: number
  account: 'CASH_CLEARING' | 'COGS_RECOVERY' | 'PROVIDER_PAYABLE' | 'PLATFORM_FEE_REVENUE'
  lineId: string | null
  amountCents: number
  memo: string | null
}

/** A journal with its entries and whether they sum to zero (money rule 7). */
export interface AuditJournal {
  id: string
  type: 'PAYMENT' | 'REFUND'
  refId: string | null
  isSynthetic: boolean
  postedAt: string
  entries: AuditLedgerEntry[]
  entrySumCents: number
  sumsToZero: boolean
}

export interface AuditMovement {
  id: number
  sku: string
  deltaOnHand: number
  deltaReserved: number
  reason: string
  createdAt: string
}

/** One named invariant check with its explicit pass/fail result (FR-7 AC1). */
export interface InvariantCheck {
  name: string
  pass: boolean
  detail?: Record<string, unknown>
}

/** The invariants block: every check passes or fails explicitly; `ok` is the AND. */
export interface AuditInvariants {
  ok: boolean
  checks: InvariantCheck[]
}

/** GET /api/orders/:id/audit response (FR-7 AC1). */
export interface AuditResponse {
  order: AuditOrder
  lines: AuditLine[]
  statusHistory: AuditEvent[]
  payments: AuditPayment[]
  refunds: AuditRefund[]
  journals: AuditJournal[]
  inventoryMovements: AuditMovement[]
  invariants: AuditInvariants
}
