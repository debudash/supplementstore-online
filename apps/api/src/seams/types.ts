// Seam interfaces (AGENTS.md section 6, docs/ARCHITECTURE.md section 7).
// External dependencies are reached ONLY through these interfaces. No business
// module imports a stub directly; everything resolves through the container in
// seams/index.ts.

/** Result of a gateway charge. A declined charge is a normal (non-throwing) result. */
export interface ChargeResult {
  status: 'succeeded' | 'declined'
  gatewayRef: string
}

export interface RefundResult {
  gatewayRef: string
}

/** Stripe-style payment gateway. The stub forces a decline at amount 1313 cents. */
export interface PaymentGateway {
  charge(amountCents: number, idempotencyKey: string, method?: string): Promise<ChargeResult>
  refund(gatewayRef: string, amountCents: number): Promise<RefundResult>
}

/** 3PL / shipping. The stub just confirms; the business layer records fulfilled_at. */
export interface FulfillmentService {
  markFulfilled(orderId: string): Promise<{ shipmentRef: string }>
}

/** Minimal recipient shape the notifier needs - never patient economics. Reused for
 *  both the pay link and the refund notice. */
export interface PayLinkRecipient {
  id: string
  name?: string
  email?: string | null
}

/**
 * Patient-safe refund notice payload (ADR-023). Patient-facing, so it carries ONLY
 * values a patient may see: the refunded amount and the keep/dispose instruction. It
 * must NEVER carry COGS, margin, fee, provider ids, or any economics (AGENTS.md
 * section 8, NFR-5) - same whitelist discipline as apps/api/src/payments/serializer.ts.
 * The business layer passes patient-safe values only; no order-with-economics object.
 */
export interface RefundNotice {
  /** Amount refunded to the patient, in cents (what the patient paid). */
  refundedAmountCents: number
  /**
   * True when the product was already delivered and is written off per ADR-013: the
   * patient should KEEP or safely DISPOSE of the product and must NOT return it. False
   * when the order was refunded before fulfillment (stock restocked, nothing shipped),
   * so there is nothing for the patient to return.
   */
  keepOrDispose: boolean
}

/** Email/SMS notifier. The stub logs; the UI shows a copyable link. */
export interface Notifier {
  sendPayLink(recipient: PayLinkRecipient, url: string): Promise<void>
  /**
   * Tell the patient a refund was issued and whether to keep/dispose the product
   * (ADR-023). Patient-safe payload only (see RefundNotice).
   */
  sendRefundNotice(recipient: PayLinkRecipient, notice: RefundNotice): Promise<void>
}

/** Provider payout. Not executed in this slice (AGENTS.md / FR-11 AC4). */
export interface PayoutService {
  payout(statement: { id: string; providerId: string; amountCents: number }): Promise<{
    payoutRef: string
  }>
}

/** Time source. Injectable so the demo data generator can backdate events. */
export interface Clock {
  now(): Date
}

/** Container of all seams, resolved once and passed to business modules. */
export interface Seams {
  paymentGateway: PaymentGateway
  fulfillment: FulfillmentService
  notifier: Notifier
  payout: PayoutService
  clock: Clock
}
