// Payment domain errors (T4). Codes and HTTP statuses per docs/ARCHITECTURE.md
// section 9. The handler maps every thrown error to the AGENTS.md section 8 envelope.
//
// PRIVACY (RT-10, NFR-5): these errors are raised on patient token routes, so no
// message or detail payload here ever carries COGS, fee, margin, or other patient's
// data. Keep detail payloads to safe, non-economic facts.
import type { Response } from 'express'
import { MoneyError } from '@cerbo/money'
import { sendError } from '../http'
import { ApiError as OrdersApiError } from '../orders/errors'

/** Payment/pay-flow error codes mapped to their HTTP status (ARCHITECTURE section 9). */
const STATUS_BY_CODE: Record<string, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  ORDER_NOT_PAYABLE: 409,
  ORDER_EXPIRED: 409,
  ALREADY_PAID: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PAYMENT_DECLINED: 402
}

/** A payment error with a stable code, HTTP status, and optional (non-economic) details. */
export class PaymentError extends Error {
  readonly code: string
  readonly status: number
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'PaymentError'
    this.code = code
    this.status = STATUS_BY_CODE[code] ?? 400
    this.details = details
    Object.setPrototypeOf(this, PaymentError.prototype)
  }
}

export const notFound = (message = 'Not found', details: Record<string, unknown> = {}): PaymentError =>
  new PaymentError('NOT_FOUND', message, details)
export const invalidInput = (message: string, details: Record<string, unknown> = {}): PaymentError =>
  new PaymentError('INVALID_INPUT', message, details)
export const orderNotPayable = (status: string): PaymentError =>
  new PaymentError('ORDER_NOT_PAYABLE', 'This order cannot be paid', { status })
export const orderExpired = (): PaymentError =>
  new PaymentError('ORDER_EXPIRED', 'This order has expired and can no longer be paid')
export const alreadyPaid = (): PaymentError =>
  new PaymentError('ALREADY_PAID', 'This order has already been paid')
export const idempotencyConflict = (): PaymentError =>
  new PaymentError('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for another order')
export const paymentDeclined = (): PaymentError =>
  new PaymentError('PAYMENT_DECLINED', 'The payment was declined')

/**
 * True for any error that already carries a stable `code` + HTTP `status`: both
 * PaymentError and the orders module's ApiError (which the pay flow may surface when it
 * calls order/inventory helpers). Lets one handler serialise both without coupling.
 */
function hasCodeAndStatus(err: unknown): err is { code: string; status: number; message: string; details?: Record<string, unknown> } {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { status?: unknown }).status === 'number'
  )
}

/**
 * Map any thrown error to the standard envelope. We respond here rather than rethrowing:
 * these handlers are async, so a throw would become an unhandled rejection the central
 * error middleware never sees.
 *
 * MoneyError should not reach a pay route (amounts are snapshotted, never recomputed at
 * pay time), but it is handled defensively - and WITHOUT its detail payload, which can
 * carry margin/cogs, so patient routes never leak economics (RT-10).
 */
export function handlePaymentError(res: Response, err: unknown): void {
  if (err instanceof MoneyError) {
    const status = err.code === 'MARGIN_NEGATIVE' ? 422 : 400
    sendError(res, status, err.code, 'Unable to process this order')
    return
  }
  if (err instanceof PaymentError || err instanceof OrdersApiError || hasCodeAndStatus(err)) {
    const e = err as { code: string; status: number; message: string; details?: Record<string, unknown> }
    sendError(res, e.status, e.code, e.message, e.details ?? {})
    return
  }
  console.error('[api:error]', err)
  sendError(res, 500, 'INTERNAL', 'Internal server error')
}
