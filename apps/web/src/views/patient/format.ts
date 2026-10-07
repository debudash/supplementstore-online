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

import { formatMoney } from '../../utils/money'

/** Format integer cents for display. Delegates to the shared formatter (utils/money.ts). */
export function formatCents(cents: number): string {
  return formatMoney(cents)
}
