// Domain errors for the refunds + fulfillment modules (T5).
//
// Service functions throw RefundError; the caller (route handler) maps each to the
// error envelope in AGENTS.md section 8 with the HTTP status from
// docs/ARCHITECTURE.md section 9. Mirrors the T3/T4 error pattern so handlers stay thin
// and the shape is uniform across the API.
import type { Response } from 'express'
import { MoneyError } from '@cerbo/money'
import { sendError } from '../http'
import { ApiError as OrdersApiError } from '../orders/errors'

/** Refund/fulfillment error codes mapped to their HTTP status (ARCHITECTURE section 9). */
const STATUS_BY_CODE: Record<string, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  ORDER_NOT_PAYABLE: 409,
  ALREADY_REFUNDED: 409,
  NOT_REFUNDABLE: 409
}

/** A business error with a stable code, HTTP status, and optional detail payload. */
export class RefundError extends Error {
  readonly code: string
  readonly status: number
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RefundError'
    this.code = code
    this.status = STATUS_BY_CODE[code] ?? 400
    this.details = details
    Object.setPrototypeOf(this, RefundError.prototype)
  }
}

/** Convenience constructors for the codes these modules raise. */
export const notFound = (message = 'Resource not found', details: Record<string, unknown> = {}): RefundError =>
  new RefundError('NOT_FOUND', message, details)
export const invalidInput = (message: string, details: Record<string, unknown> = {}): RefundError =>
  new RefundError('INVALID_INPUT', message, details)
/** Second refund attempt on an already-refunded order (FR-8 AC5, RT-08). */
export const alreadyRefunded = (): RefundError =>
  new RefundError('ALREADY_REFUNDED', 'This order has already been refunded')
/** Refund attempted on an order that is not in a refundable (paid) state (FR-8 AC5). */
export const notRefundable = (status: string): RefundError =>
  new RefundError('NOT_REFUNDABLE', 'Only a paid order can be refunded', { status })
/** Fulfillment attempted on an order that is not a fulfillable (paid) order (FR-9 AC2). */
export const notFulfillable = (status: string): RefundError =>
  new RefundError('ORDER_NOT_PAYABLE', 'Only a paid order can be fulfilled', { status })

/**
 * Map any thrown error to the standard envelope. RefundError and the orders module's
 * ApiError both carry a code + HTTP status; MoneyError (which refund amount computation
 * may raise defensively) is mapped by its code. Anything else is a logged 500.
 *
 * We respond here rather than rethrowing: these handlers are async, so a throw would
 * become an unhandled rejection the central error middleware never sees.
 */
export function handleRefundError(res: Response, err: unknown): void {
  if (err instanceof MoneyError) {
    const status = err.code === 'MARGIN_NEGATIVE' ? 422 : 400
    sendError(res, status, err.code, err.message, { ...err.details })
    return
  }
  if (err instanceof RefundError || err instanceof OrdersApiError) {
    sendError(res, err.status, err.code, err.message, err.details)
    return
  }
  console.error('[api:error]', err)
  sendError(res, 500, 'INTERNAL', 'Internal server error')
}
