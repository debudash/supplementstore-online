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

/** Minimal recipient shape the notifier needs - never patient economics. */
export interface PayLinkRecipient {
  id: string
  name?: string
  email?: string | null
}

/** Email/SMS notifier. The stub logs; the UI shows a copyable link. */
export interface Notifier {
  sendPayLink(recipient: PayLinkRecipient, url: string): Promise<void>
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
