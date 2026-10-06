// @cerbo/contracts - shared request/response types.
//
// T0 ships only the cross-cutting primitives (roles and the error envelope).
// Each module's task adds its own file here (orders.ts, payments.ts, audit.ts, ...)
// per docs/ARCHITECTURE.md section 2 and re-exports it below.

/** Actor roles recognised by the demo auth stub (AGENTS.md section 7). */
export type Role = 'provider' | 'patient' | 'cerbo_admin'

/** Canonical API error codes (docs/ARCHITECTURE.md section 9). */
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'DEMO_DISABLED'
  | 'NOT_FOUND'
  | 'INSUFFICIENT_STOCK'
  | 'ORDER_NOT_EDITABLE'
  | 'ORDER_NOT_PAYABLE'
  | 'ORDER_EXPIRED'
  | 'ALREADY_PAID'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ALREADY_REFUNDED'
  | 'NOT_REFUNDABLE'
  | 'MARGIN_NEGATIVE'
  | 'PAYMENT_DECLINED'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL'

/** Standard error envelope returned by every API route (AGENTS.md section 8). */
export interface ApiError {
  error: {
    code: ErrorCode | string
    message: string
    details?: Record<string, unknown>
  }
}

// Per-module contract re-exports. Every file under packages/contracts/src/ is surfaced
// here so consumers import request/response types from '@cerbo/contracts' (one source of
// truth, no local mirrors). Each module's task adds its own line as its file lands.
// Present now: orders (T3), patients (T3). T4 adds payments and audit; T5 adds refunds; etc.
export * from './orders'
export * from './patients'
export * from './payments'
export * from './audit'
