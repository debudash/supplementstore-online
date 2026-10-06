// Display-only money formatting for the patient pay pages (T7).
//
// The patient UI DISPLAYS money, it never CALCULATES it (AGENTS.md money rules 1-2):
// every amount is an integer-cents snapshot from the server. This helper only formats
// those cents for display - pure integer decomposition, never float arithmetic on a
// dollar value, never toFixed, never parseFloat (a CI guard greps for those call forms).
//
// Owned by T7 (apps/web/src/views/patient/**). The provider UI has its own copy under
// components/order/ (T6); the two are kept independent rather than cross-importing
// across task ownership boundaries.

/**
 * Format integer cents as a dollar string, e.g. 8497 -> "$84.97", 100 -> "$1.00".
 * Pure integer decomposition (trunc + modulo on cents). Non-finite input renders as a
 * dash so a bad value never throws in a template.
 */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return '-'
  const negative = cents < 0
  const abs = Math.abs(Math.trunc(cents))
  const dollars = Math.trunc(abs / 100)
  const remainder = abs % 100
  const centsPart = String(remainder).padStart(2, '0')
  return `${negative ? '-' : ''}$${dollars.toLocaleString('en-US')}.${centsPart}`
}
