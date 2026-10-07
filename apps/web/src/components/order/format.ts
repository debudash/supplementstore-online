// Display-only helpers for the provider order UI (T6).
//
// The UI DISPLAYS, it never CALCULATES money (AGENTS.md money rule 2): every fee,
// allocation, and margin figure comes from the server quote endpoint. These helpers
// only format integer cents for display and translate the margin-% INPUT into the
// basis points the API expects. No float money math, no toFixed, no parseFloat.

import { formatMoney } from '../../utils/money'

/** Format integer cents for display. Delegates to the shared formatter (utils/money.ts). */
export function formatCents(cents: number): string {
  return formatMoney(cents)
}

/**
 * Render integer cents as a plain editable amount, e.g. 2999 -> "29.99", 100 -> "1.00".
 * Used to seed a price input (no "$", no thousands grouping). Integer decomposition only.
 */
export function centsToPlain(cents: number): string {
  if (!Number.isFinite(cents)) return ''
  const abs = Math.abs(Math.trunc(cents))
  const dollars = Math.trunc(abs / 100)
  const centsPart = String(abs % 100).padStart(2, '0')
  return `${cents < 0 ? '-' : ''}${dollars}.${centsPart}`
}

/**
 * Parse a dollar amount string into integer cents WITHOUT float math (AGENTS.md money
 * rule 1 forbids parsing "29.99" into cents via floats). "29.99" -> 2999, "30" -> 3000,
 * "0.05" -> 5. Accepts an optional one- or two-digit cents part; returns null for
 * anything malformed or negative so the caller can show an input error.
 */
export function dollarsToCents(input: string): number | null {
  const trimmed = input.trim().replace(/^\$/, '')
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  const [whole, frac = ''] = trimmed.split('.')
  const fracPadded = (frac + '00').slice(0, 2)
  return Number(whole) * 100 + Number(fracPadded)
}

/** Exact copy required by FR-3 AC2 / EVAL-05 for the INSUFFICIENT_STOCK alert. */
export function insufficientStockMessage(available: number): string {
  return `On-hand stock cannot meet this quantity (available: ${available}). Wait for restock or reduce quantity.`
}

/**
 * Translate a margin-% input string into integer basis points for the API
 * (1% = 100 bps; ADR-005, FR-2 AC1). Accepts up to two decimal places, e.g.
 * "50" -> 5000, "37.5" -> 3750, "37.52" -> 3752. Returns null for anything that is
 * not a clean non-negative number so the caller can show an input error. Server-side
 * range validation (0..9500) is authoritative; this only shapes the request.
 */
export function marginPercentToBps(input: string): number | null {
  const trimmed = input.trim()
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null
  const [whole, frac = ''] = trimmed.split('.')
  const fracPadded = (frac + '00').slice(0, 2)
  return Number(whole) * 100 + Number(fracPadded)
}
