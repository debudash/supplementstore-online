// @cerbo/contracts - patient "My Orders" listing types.
//
// Backs GET /api/patient/orders: a patient-facing list so a patient can find the pay link
// for their own orders when it was not copied at send time (the pay_token is stored on the
// order but was never surfaced again). This is a SEPARATE, role-guarded and
// ownership-scoped surface - it does NOT weaken the token model (AGENTS.md section 7):
// payment itself still happens at the token route /api/pay/:token. This endpoint only lets
// a patient discover their OWN tokens; ownership scoping makes another patient's orders
// unreachable.
//
// PRIVACY: every money field here is the patient-safe subtotal/price only. COGS, fee,
// margin and provider economics never appear - the server builds each item through the
// same whitelist serializer the pay page uses (apps/api/src/payments/serializer.ts), so
// there is nothing to leak (EVAL-12, RT-10, NFR-5).
import type { OrderStatus, PatientRefundReason, RefundRequestView } from './orders'
import type { PatientPayItem } from './payments'

/** One order as the patient sees it in their list. All money is integer cents and
 * patient-safe (the order subtotal / line prices only). */
export interface PatientOrderListItem {
  orderId: string
  /** Lifecycle status (draft orders are never listed - only orders actually sent). */
  status: OrderStatus
  /** When the order was sent to the patient (ISO 8601). Always present for listed orders. */
  sentAt: string | null
  /** When the order was paid (ISO 8601), or null if not paid. */
  paidAt: string | null
  /** Amount the patient pays / paid = the order subtotal snapshot, in cents. */
  amountCents: number
  /** The patient's own pay token for this order (safe: it is their own). Null if none. */
  payToken: string | null
  /** Ready-made pay path, e.g. "/pay/<token>", or null if there is no token. */
  payPath: string | null
  /** True when the order can still be paid now (status 'sent'); false once paid/closed. */
  isPayable: boolean
  /** Line preview, whitelisted (name, qty, unit price, line total) - no economics. */
  items: PatientPayItem[]
  /** The latest refund request on this order (status, reason, dates, provider's note). */
  refundRequest: RefundRequestView | null
  /** True when the patient may ask for a refund now (paid, within 30 days, nothing pending). */
  canRequestRefund: boolean
  /** When the 30-day refund window closes (ADR-027), or null if not paid. */
  refundWindowEndsAt: string | null
}

/** POST /api/patient/orders/:id/refund-request body (ADR-027: unopened, within 30 days). */
export interface RefundRequestCreate {
  reasonCode: PatientRefundReason
  /** Must be true: the patient confirms the product is unopened. */
  unopened: true
  /** Optional detail for the provider, at most 500 characters. */
  note?: string
}

/** GET /api/patient/orders response: the caller's own orders, most recently sent first. */
export interface PatientOrdersResponse {
  orders: PatientOrderListItem[]
}
