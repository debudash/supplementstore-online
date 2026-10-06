import { assertSafeIntegerInRange, assertSafePositiveInt } from "./validate";

/** Default platform fee in basis points (0.75%). Snapshotted on the order (ADR-001). */
export const DEFAULT_FEE_BPS = 75;

/**
 * Order-level platform fee, computed ONCE per order, half-up, in integer cents.
 *
 * ADR-001: fee = 0.75% of the patient-paid subtotal.
 * ADR-003: integer cents everywhere; fee computed once per order, half-up.
 *
 *   orderFee = floor((subtotalCents * feeBps + 5000) / 10000)
 *
 * `feeBps` is a parameter (default 75), never hard-coded inside the arithmetic,
 * because it is snapshotted on the order (AGENTS.md money rule 3).
 *
 * The `+ 5000` term is the integer half-up rounding bias: it is half of the
 * divisor (10000), so a raw fee of exactly x.5 cents rounds up (EVAL-03) while
 * x.4925 rounds down (EVAL-02). No float, no toFixed, no Math.round.
 */
export function orderFee(subtotalCents: number, feeBps: number = DEFAULT_FEE_BPS): number {
  assertSafePositiveInt(subtotalCents, "subtotalCents");
  // feeBps is a rate in basis points; 0..10000 (0%..100%) is the sane domain.
  assertSafeIntegerInRange(feeBps, "feeBps", 0, 10000);
  return Math.floor((subtotalCents * feeBps + 5000) / 10000);
}
