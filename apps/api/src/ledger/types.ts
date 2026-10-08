// API-side audit response types (T4), mirroring packages/contracts/src/audit.ts.
//
// The @cerbo/contracts package exports only its index barrel and apps/api does not
// depend on it, so - following the T3 precedent (see apps/api/src/inventory/service.ts)
// - the API declares these shapes locally and keeps them in sync with the contract.
export type LedgerAccountName =
  | 'CASH_CLEARING'
  | 'COGS_RECOVERY'
  | 'PROVIDER_PAYABLE'
  | 'PLATFORM_FEE_REVENUE'

export interface AuditOrder {
  id: string
  status: string
  kind: string
  providerId: string
  practiceId: string
  patientId: string
  /** Display names (provider/admin audit only). Null if the record is missing. */
  patientName: string | null
  providerName: string | null
  practiceName: string | null
  feeBps: number
  subtotalCents: number | null
  cogsCents: number | null
  feeCents: number | null
  marginCents: number | null
  /** Sum of qty x markup; null unless every line has a markup. With round-once pricing
   *  (ADR-028) it equals marginCents: subtotal = cogs + fee + markup, to the cent. */
  markupCents: number | null
  isSynthetic: boolean
  createdAt: string
  sentAt: string | null
  paidAt: string | null
  fulfilledAt: string | null
  cancelledAt: string | null
  expiredAt: string | null
  refundedAt: string | null
  payToken: string | null
  payPath: string | null
}

export interface AuditLine {
  id: string
  position: number
  sku: string
  name: string
  qty: number
  unitPriceCents: number
  unitCogsCents: number
  /** The provider's per-unit markup (ADR-028); null on lines priced before it. */
  unitMarkupCents: number | null
  lineTotalCents: number | null
  lineCogsCents: number | null
  lineFeeCents: number | null
  lineMarginCents: number | null
  /** qty x unit markup (ADR-028): the provider's share of the line; null on lines priced before it. */
  lineMarkupCents: number | null
  /** True when lineTotalCents / qty is not a whole cent (the order is rounded once, ADR-028). */
  unitPriceIsAverage: boolean
}

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

export interface AuditLedgerEntry {
  id: number
  account: LedgerAccountName
  lineId: string | null
  amountCents: number
  memo: string | null
}

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

export interface InvariantCheck {
  name: string
  pass: boolean
  detail?: Record<string, unknown>
}

export interface AuditInvariants {
  ok: boolean
  checks: InvariantCheck[]
}

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
