// @cerbo/contracts - refund and fulfillment request/response types (T5).
//
// FR-8 (whole-order refunds) and FR-9 (fulfillment stub). These shapes back the
// provider refund route (POST /api/orders/:id/refund) and the Cerbo Admin routes
// (POST /api/admin/orders/:id/refund, POST /api/admin/orders/:id/fulfill) in
// docs/ARCHITECTURE.md section 8. They are the canonical contract the web clients
// (T7 patient copy, T11 admin console) consume.
//
// These are PROVIDER / Cerbo Admin surfaces, not patient-facing, so the refund result
// carries the retained-fee and write-off economics. The patient-facing refund notice
// (the do-not-return message, ADR-023) goes through the Notifier seam and never carries
// COGS, margin, or fee (AGENTS.md section 8, NFR-5).
import type { OrderStatus } from './orders'

/**
 * Required reason code on a refund (FR-8 AC1). Matches the refunds.reason_code enum in
 * docs/ARCHITECTURE.md section 3 exactly - no other value is accepted.
 */
export type RefundReasonCode = 'damaged' | 'wrong_item' | 'patient_request' | 'provider_error' | 'other'

/** All accepted reason codes, for validation and UI enumeration. */
export const REFUND_REASON_CODES: readonly RefundReasonCode[] = [
  'damaged',
  'wrong_item',
  'patient_request',
  'provider_error',
  'other'
]

/** POST /api/orders/:id/refund and POST /api/admin/orders/:id/refund request body. */
export interface RefundRequest {
  reasonCode: RefundReasonCode
}

/**
 * Refund result (FR-8). Whole-order only (ADR-014). The patient receives 100% of the
 * amount paid (ADR-012); the platform fee is retained by Cerbo and charged to the
 * provider (`feeRetainedCents`). If the order was not yet fulfilled the units are
 * restocked (`restocked = true`); if it was fulfilled nothing is restocked and
 * `writeoffCogsCents` records the COGS Cerbo absorbs (ADR-013).
 */
export interface RefundResult {
  refundId: string
  orderId: string
  status: Extract<OrderStatus, 'refunded'>
  reasonCode: RefundReasonCode
  /** Cash returned to the patient = order subtotal (100% of what they paid). */
  amountCents: number
  /** Platform fee retained by Cerbo and charged to the provider (ADR-012). */
  feeRetainedCents: number
  /** True if the units were returned to stock (refund before fulfillment). */
  restocked: boolean
  /** COGS written off when refunding a fulfilled order (0 when restocked). */
  writeoffCogsCents: number
}

/**
 * Fulfillment result (FR-9). Cerbo Admin marks a paid order fulfilled through the
 * FulfillmentService seam; the order stays `paid` and gains a `fulfilledAt` timestamp.
 * Refunded orders cannot be fulfilled (FR-9 AC2).
 */
export interface FulfillResult {
  orderId: string
  status: OrderStatus
  fulfilledAt: string
}
