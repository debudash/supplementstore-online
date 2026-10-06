// Domain errors for the Cerbo Admin metrics + demo modules (T10). Same pattern as
// apps/api/src/reports/errors.ts: service code throws ApiError, the router maps it to the
// AGENTS.md section 8 envelope with the HTTP status from ARCHITECTURE section 9.
import type { Response } from 'express'
import { sendError } from '../http'

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_INPUT: 400,
  FORBIDDEN: 403,
  DEMO_DISABLED: 403,
  NOT_FOUND: 404,
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
export const demoDisabled = (): ApiError =>
  new ApiError('DEMO_DISABLED', 'Demo-only endpoints are disabled (DEMO_MODE is not true)')

/**
 * Duck-typed guard for an ApiError-shaped error. Reports (T8) and this module define
 * their own ApiError classes, so a plain `instanceof` would miss a reports-thrown error
 * we re-raise by reusing reports/period. Matching on the (code, status) shape handles
 * both without coupling the two class identities.
 */
function isApiErrorShape(
  err: unknown
): err is { code: string; status: number; message: string; details?: Record<string, unknown> } {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { status?: unknown }).status === 'number'
  )
}

/** Map any thrown error to the standard envelope (see apps/api/src/reports/errors.ts). */
export function handleError(res: Response, err: unknown): void {
  if (isApiErrorShape(err)) {
    sendError(res, err.status, err.code, err.message, err.details ?? {})
    return
  }
  console.error('[api:error]', err)
  sendError(res, 500, 'INTERNAL', 'Internal server error')
}
