// Domain errors for the order + inventory modules (T3).
//
// Service functions throw ApiError; the router maps each to the error envelope in
// AGENTS.md section 8 with the HTTP status from docs/ARCHITECTURE.md section 9.
// Keeping the mapping in one place means handlers stay thin and the shape is uniform.
import type { Response } from 'express'
import { MoneyError } from '@cerbo/money'
import { sendError } from '../http'

/** Canonical T3 error codes mapped to their HTTP status. */
const STATUS_BY_CODE: Record<string, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  INSUFFICIENT_STOCK: 409,
  ORDER_NOT_EDITABLE: 409,
  ORDER_NOT_PAYABLE: 409,
  // Refund requests: only paid (real) orders, one open request at a time, and a decision
  // needs a pending request.
  NOT_REFUNDABLE: 409,
  REFUND_REQUEST_EXISTS: 409,
  REFUND_WINDOW_CLOSED: 409,
  NO_PENDING_REQUEST: 409,
  MARGIN_NEGATIVE: 422
}

/** A business error with a stable code, HTTP status, and optional detail payload. */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = STATUS_BY_CODE[code] ?? 400
    this.details = details
    Object.setPrototypeOf(this, ApiError.prototype)
  }
}

/** Convenience constructors for the codes this module raises. */
export const notFound = (message = 'Resource not found', details: Record<string, unknown> = {}): ApiError =>
  new ApiError('NOT_FOUND', message, details)
export const invalidInput = (message: string, details: Record<string, unknown> = {}): ApiError =>
  new ApiError('INVALID_INPUT', message, details)
export const insufficientStock = (available: number): ApiError =>
  new ApiError('INSUFFICIENT_STOCK', 'Not enough stock to satisfy this quantity', { available })
export const orderNotEditable = (status: string): ApiError =>
  new ApiError('ORDER_NOT_EDITABLE', 'Order can only be edited while it is a draft', { status })

/**
 * Map any thrown error to the standard envelope. ApiError and MoneyError carry their
 * own codes and HTTP statuses; anything unexpected is logged and returned as a 500
 * INTERNAL. We respond here rather than rethrowing: these handlers are async, and a
 * throw out of an async Express handler becomes an unhandled rejection the central
 * error middleware never sees.
 */
export function handleError(res: Response, err: unknown): void {
  if (err instanceof ApiError) {
    sendError(res, err.status, err.code, err.message, err.details)
    return
  }
  if (err instanceof MoneyError) {
    const status = err.code === 'MARGIN_NEGATIVE' ? 422 : 400
    sendError(res, status, err.code, err.message, { ...err.details })
    return
  }
  console.error('[api:error]', err)
  sendError(res, 500, 'INTERNAL', 'Internal server error')
}
