// Shared HTTP helpers. Every error response uses the envelope from AGENTS.md
// section 8: { error: { code, message, details } }. Codes and statuses are the
// table in docs/ARCHITECTURE.md section 9.
import type { Response } from 'express'

export interface ErrorBody {
  error: {
    code: string
    message: string
    details: Record<string, unknown>
  }
}

/** Send a standard error envelope. */
export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {}
): void {
  const body: ErrorBody = { error: { code, message, details } }
  res.status(status).json(body)
}

/**
 * 501 stub response for pre-registered routes that a later task will implement.
 * Keeps the error shape consistent so clients and tests can rely on it now.
 */
export function notImplemented(res: Response, route: string): void {
  sendError(res, 501, 'NOT_IMPLEMENTED', `Not implemented yet: ${route}`, { route })
}
