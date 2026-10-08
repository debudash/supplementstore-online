// The ONE money formatter for the whole UI.
//
// The UI displays money, it never calculates it (AGENTS.md money rules 1-2): every
// amount arrives from the API as integer cents. To format, we decompose the cents with
// integer math into an exact decimal STRING ("1234.56") and hand that string to
// Intl.NumberFormat (en-US, USD), so no float arithmetic ever touches a money value.

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

/** Exact decimal string for integer cents, e.g. -8497 -> "-84.97". Integer math only. */
function centsToDecimalString(cents: number): string {
  const whole = Math.trunc(cents)
  const abs = Math.abs(whole)
  const dollars = Math.trunc(abs / 100)
  const rest = String(abs % 100).padStart(2, '0')
  return `${whole < 0 ? '-' : ''}${dollars}.${rest}`
}

/**
 * Format integer cents as US dollars: 2999 -> "$29.99", -64 -> "-$0.64",
 * 123456 -> "$1,234.56". Null, undefined and non-finite values render as "-".
 */
export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '-'
  // Intl.NumberFormat formats a decimal string exactly (ECMA-402 NumberFormat v3);
  // the cast is only for older TypeScript lib typings that declare number | bigint.
  return usd.format(centsToDecimalString(cents) as unknown as number)
}

/** True when an amount should be styled as negative. */
export function isNegative(cents: number | null | undefined): boolean {
  return typeof cents === 'number' && Number.isFinite(cents) && cents < 0
}

/** Format basis points as a percent label for display: 7500 -> "75%", 75 -> "0.75%". */
export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '-'
  const whole = Math.trunc(bps / 100)
  const frac = Math.abs(bps % 100)
  if (frac === 0) return `${whole}%`
  const fracStr = String(frac).padStart(2, '0').replace(/0$/, '')
  return `${bps < 0 && whole === 0 ? '-' : ''}${whole}.${fracStr}%`
}

/**
 * Whether a patient line's unit price is an average (ADR-028: the order total is rounded
 * once, so a line total need not be qty x a whole-cent price). Display-only: it compares
 * two server figures to pick a label ("each" vs "avg each"); it never computes a charge.
 */
export function isAverageUnitPrice(item: { qty: number; unitPriceCents: number; lineTotalCents: number }): boolean {
  return item.qty * item.unitPriceCents !== item.lineTotalCents
}
