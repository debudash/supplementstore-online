// @cerbo/contracts - patient payment request/response types (T4).
//
// FR-5 (patient payment, stubbed). These shapes back the token-based patient pay
// routes in docs/ARCHITECTURE.md section 8 (GET/POST /api/pay/:token). They are the
// canonical contract the web client (T7) consumes.
//
// PRIVACY (NFR-5, RT-10, EVAL-12): the patient-facing view is a STRICT whitelist. It
// never carries COGS, fee, margin, or any provider economics. The API serializer in
// apps/api/src/payments/serializer.ts must produce exactly these keys and no others.
import type { OrderStatus } from './orders'

/** One line as the patient sees it: name, quantity, unit price, line total. Nothing else. */
export interface PatientPayItem {
  name: string
  qty: number
  unitPriceCents: number
  lineTotalCents: number
}

/**
 * GET /api/pay/:token - the patient-safe view of an order (FR-5 AC1, EVAL-12).
 * The key set here is exhaustive: items, totalCents, status, patientFirstName.
 */
export interface PatientPayView {
  items: PatientPayItem[]
  /** What the patient pays = order subtotal (the fee is borne by the provider, ADR-002). */
  totalCents: number
  status: OrderStatus
  /** First name only; never the full patient record. */
  patientFirstName: string
}

/**
 * POST /api/pay/:token request body (FR-5 AC2). The idempotency key makes a repeated
 * submit safe. Any price/total fields a client might add are IGNORED (RT-03, money
 * rule 9): the server charges the snapshot subtotal.
 */
export interface PayRequest {
  idempotencyKey: string
}

/**
 * POST /api/pay/:token result (FR-5). Patient-safe: a payment id, the final status,
 * and the total charged. No provider economics. Re-submitting the same key returns
 * the identical result (same paymentId).
 */
export interface PayResult {
  paymentId: string
  status: Extract<OrderStatus, 'paid'>
  totalCents: number
  /** When the payment was recorded (ISO); same value on an idempotent replay. */
  paidAt: string
}

/**
 * GET /api/pay/:token/practice and /api/pay/schedule/:token/practice: who the patient
 * is paying. Separate from PatientPayView so that view's strict whitelist is unchanged.
 */
export interface PatientPracticeView {
  practiceName: string | null
  providerName: string | null
}
