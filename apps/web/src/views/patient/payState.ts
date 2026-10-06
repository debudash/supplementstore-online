// Pure display-state logic for the patient pay page (T7, FR-5 AC1-AC3).
//
// The Pay.vue component is a thin wrapper over these pure functions, so the state
// machine and the patient-facing copy can be tested without a DOM harness
// (@vue/test-utils is a devDependency the scope guardrails tell us to avoid).
//
// PRIVACY (NFR-5, RT-10): nothing here surfaces COGS, fee, margin, or provider
// economics - not in the happy path and not in any error state. The copy below is the
// only patient-facing text the page shows for each terminal state.
import type { OrderStatus } from '@cerbo/contracts'

/**
 * The visible state of the pay page. Derived from the fetched order status, then
 * advanced by the result (or error) of a pay attempt.
 *  - loading     : the GET is in flight
 *  - payable     : order is `sent`; the pay button is shown
 *  - paid        : THIS page load just completed the payment (we hold the receipt)
 *  - alreadyPaid : the order was already paid before this page load (no receipt to show)
 *  - expired     : the reservation window lapsed; no longer payable
 *  - cancelled   : the provider cancelled the order
 *  - refunded    : the order was refunded in full (ADR-012 / ADR-023 message)
 *  - unavailable : any other non-payable status (draft, on_hold)
 *  - notFound    : the pay link is unknown (404)
 *  - error       : an unexpected failure
 */
export type PayPhase =
  | 'loading'
  | 'payable'
  | 'paid'
  | 'alreadyPaid'
  | 'expired'
  | 'cancelled'
  | 'refunded'
  | 'unavailable'
  | 'notFound'
  | 'error'

/** Map the order status from GET /api/pay/:token to the initial display phase. */
export function phaseForStatus(status: OrderStatus): PayPhase {
  switch (status) {
    case 'sent':
      return 'payable'
    case 'paid':
      return 'alreadyPaid'
    case 'expired':
      return 'expired'
    case 'cancelled':
      return 'cancelled'
    case 'refunded':
      return 'refunded'
    default:
      // draft, on_hold - reachable in principle but not something a patient can pay.
      return 'unavailable'
  }
}

/**
 * Map an error code from POST /api/pay/:token to the phase the page should move to.
 * PAYMENT_DECLINED is handled separately by the caller: a decline keeps the page
 * `payable` (the patient may retry with the SAME idempotency key) and shows a decline
 * notice, so it never reaches here.
 */
export function phaseForPayError(code: string): PayPhase {
  switch (code) {
    case 'ALREADY_PAID':
      return 'alreadyPaid'
    case 'ORDER_EXPIRED':
      return 'expired'
    case 'ORDER_NOT_PAYABLE':
      return 'unavailable'
    default:
      // INVALID_INPUT, IDEMPOTENCY_CONFLICT, INTERNAL, or anything unexpected.
      return 'error'
  }
}

/** Short title shown for each phase. */
export function titleForPhase(phase: PayPhase): string {
  switch (phase) {
    case 'loading':
      return 'Loading your order'
    case 'payable':
      return 'Complete your payment'
    case 'paid':
      return 'Payment complete'
    case 'alreadyPaid':
      return 'Already paid'
    case 'expired':
      return 'This order has expired'
    case 'cancelled':
      return 'This order was cancelled'
    case 'refunded':
      return 'This order was refunded'
    case 'unavailable':
      return 'This order is not available'
    case 'notFound':
      return 'Pay link not found'
    case 'error':
      return 'Something went wrong'
  }
}

/** Explanatory copy for each terminal phase (single hyphen, never an em dash). */
export function messageForPhase(phase: PayPhase): string {
  switch (phase) {
    case 'paid':
      return 'Thank you. Your payment was received.'
    case 'alreadyPaid':
      return 'This order has already been paid. No further payment is needed.'
    case 'expired':
      return 'This order has expired and can no longer be paid. Please ask your provider to send a new order.'
    case 'cancelled':
      return 'This order was cancelled and can no longer be paid. Please contact your provider with any questions.'
    case 'refunded':
      // ADR-012 (100% to the patient) and ADR-023 (keep or safely dispose; no returns).
      // ADR-023 is not yet merged - this is the documented shape, pending T5 verification.
      return 'This order was refunded in full. Please keep or safely dispose of the product; no returns are accepted.'
    case 'unavailable':
      return 'This order is not ready for payment. Please contact your provider with any questions.'
    case 'notFound':
      return 'We could not find an order for this pay link. Please check the link or contact your provider.'
    case 'error':
      return 'We could not load this page. Please try again in a moment.'
    default:
      // loading / payable have their own interactive UI rather than a message.
      return ''
  }
}

/** Copy shown when a pay attempt is declined (the patient may retry). */
export const DECLINE_NOTICE =
  'The payment was declined. Please check your payment details and try again.'
