// Strict request validation for order routes (RT-07, AGENTS.md money rule 1 & 10).
//
// The money package only ever receives safe positive integers. We reject here - at
// the HTTP boundary - any value that is not a JSON integer in range: strings like
// "29.99", floats, NaN, Infinity, negatives, zero (where disallowed), or values
// beyond Number.MAX_SAFE_INTEGER. No float ever reaches a money function.
import { invalidInput } from './errors'

/** True only for a finite, safe, integer JS number (not a numeric string). */
function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/**
 * Require an integer field within [min, max]. Throws INVALID_INPUT otherwise.
 * Only accepts an actual JSON number; a numeric string ("5", "29.99") is rejected
 * so float parsing never happens downstream.
 */
export function requireInt(value: unknown, field: string, min: number, max: number): number {
  if (!isSafeInt(value)) {
    throw invalidInput(`${field} must be an integer`, { field })
  }
  if (value < min || value > max) {
    throw invalidInput(`${field} must be between ${min} and ${max}`, { field, min, max })
  }
  return value
}

/** Optional integer field: returns undefined when absent/null, else validates. */
export function optionalInt(
  value: unknown,
  field: string,
  min: number,
  max: number
): number | undefined {
  if (value === undefined || value === null) return undefined
  return requireInt(value, field, min, max)
}

/** Require a non-empty string (sku, patientId, ...). */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidInput(`${field} is required`, { field })
  }
  return value
}

/** Quantity is an integer 1..100 (FR-1 AC3, schema check). */
export const QTY_MIN = 1
export const QTY_MAX = 100
/** Unit price is a positive integer in cents (schema check unit_price_cents > 0). */
export const PRICE_MIN = 1
export const PRICE_MAX = Number.MAX_SAFE_INTEGER
/** Margin percent in basis points, 0..9500 (FR-2 AC1). */
export const MARGIN_BPS_MIN = 0
export const MARGIN_BPS_MAX = 9500
