// Domain errors for the reports module (T8). Mirrors the T3 pattern
// (apps/api/src/orders/errors.ts): service functions throw ApiError, the router maps
// each to the AGENTS.md section 8 envelope with the status from ARCHITECTURE section 9.
//
// ALREADY_CLOSED (409) is a reports-local code: closing a month that already has an
// immutable statement for that provider+period is rejected (FR-11 AC3, unique
// (provider_id, period_start)). It is not in the ARCHITECTURE section 9 table; this is
// the one deviation, noted in the MR description. All other codes are from that table.
import type { Response } from 'express'
import { sendError } from '../http'

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_INPUT: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ALREADY_CLOSED: 409,
  INTERNAL: 500
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

export const invalidInput = (message: string, details: Record<string, unknown> = {}): ApiError =>
  new ApiError('INVALID_INPUT', message, details)
export const notFound = (message = 'Resource not found', details: Record<string, unknown> = {}): ApiError =>
  new ApiError('NOT_FOUND', message, details)
export const alreadyClosed = (month: string, providerIds: string[]): ApiError =>
  new ApiError('ALREADY_CLOSED', 'This month is already closed for one or more providers', {
    month,
    providerIds
  })

/** Map any thrown error to the standard envelope (see apps/api/src/orders/errors.ts). */
export function handleError(res: Response, err: unknown): void {
  if (err instanceof ApiError) {
    sendError(res, err.status, err.code, err.message, err.details)
    return
  }
  console.error('[api:error]', err)
  sendError(res, 500, 'INTERNAL', 'Internal server error')
}
