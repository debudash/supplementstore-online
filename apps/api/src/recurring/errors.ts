// Recurring (T9) domain errors. Codes/statuses per docs/ARCHITECTURE.md section 9,
// mapped to the AGENTS.md section 8 envelope. Two surfaces share this module:
//   - provider routes (/api/schedules) use `handleError`
//   - patient token routes (/api/pay/schedule/:token) use `handlePatientError`, which
//     NEVER leaks economics (RT-10): a MoneyError's detail payload is dropped.
//
// SCHEDULE_NOT_ACTIONABLE (409) is the one code this module adds beyond the section 9
// table: recurring is a new module and its lifecycle has a conflict state (e.g. pausing
// a cancelled schedule) with no pre-existing code. It carries no economics.
import type { Response } from 'express'
import { MoneyError } from '@cerbo/money'
import { sendError } from '../http'
import { ApiError } from '../orders/errors'

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  INSUFFICIENT_STOCK: 409,
  SCHEDULE_NOT_ACTIONABLE: 409,
  MARGIN_NEGATIVE: 422
}

/** A recurring business error with a stable code, HTTP status, and detail payload. */
export class ScheduleError extends Error {
  readonly code: string
  readonly status: number
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ScheduleError'
    this.code = code
    this.status = STATUS_BY_CODE[code] ?? 400
    this.details = details
    Object.setPrototypeOf(this, ScheduleError.prototype)
  }
}

export const notFound = (message = 'Resource not found', details: Record<string, unknown> = {}): ScheduleError =>
  new ScheduleError('NOT_FOUND', message, details)
export const invalidInput = (message: string, details: Record<string, unknown> = {}): ScheduleError =>
  new ScheduleError('INVALID_INPUT', message, details)
export const notActionable = (message: string, details: Record<string, unknown> = {}): ScheduleError =>
  new ScheduleError('SCHEDULE_NOT_ACTIONABLE', message, details)

/** Provider-surface error mapper (economics allowed in the provider's own details). */
export function handleError(res: Response, err: unknown): void {
  // Shared input validators (orders/validation: qty, markupCents) throw the orders ApiError.
  if (err instanceof ScheduleError || err instanceof ApiError) {
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

/**
 * Patient-surface error mapper for the schedule token routes. Like the pay routes
 * (apps/api/src/payments/errors.ts), it drops any economic detail payload so a patient
 * route can never leak COGS/fee/margin (RT-10, NFR-5).
 */
export function handlePatientError(res: Response, err: unknown): void {
  if (err instanceof ScheduleError) {
    // Only NOT_FOUND / INVALID_INPUT ever reach a patient route; details here are
    // non-economic (a token or field name), safe to pass through.
    sendError(res, err.status, err.code, err.message, err.details)
    return
  }
  if (err instanceof MoneyError) {
    const status = err.code === 'MARGIN_NEGATIVE' ? 422 : 400
    sendError(res, status, err.code, 'Unable to process this schedule')
    return
  }
  console.error('[api:error]', err)
  sendError(res, 500, 'INTERNAL', 'Internal server error')
}
