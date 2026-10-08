import { assertSafeIntegerInRange, assertSafePositiveInt } from "./validate";

/** Default platform fee in basis points (0.75%). Snapshotted on the order (ADR-001). */
export const DEFAULT_FEE_BPS = 75;

/**
 * Order-level platform fee, computed ONCE per order, rounded UP to the cent (ADR-001 as
 * amended by ADR-028).
 *
 *   orderFee = ceil(subtotalCents * feeBps / 10000)
 *
 * Rounding up keeps the fee at least the stated 0.75% (never below it, at most 1 cent
 * above), and together with a patient price that is also rounded up once (priceOrder)
 * leaves no rounding over: the provider receives exactly their markup.
 *
 * `feeBps` is a parameter (default 75), never hard-coded inside the arithmetic, because it
 * is snapshotted on the order (AGENTS.md money rule 3). Integer arithmetic only: the
 * `+ 9999` term is the integer ceiling for the divisor 10000.
 */
export function orderFee(subtotalCents: number, feeBps: number = DEFAULT_FEE_BPS): number {
  assertSafePositiveInt(subtotalCents, "subtotalCents");
  // feeBps is a rate in basis points; 0..10000 (0%..100%) is the sane domain.
  assertSafeIntegerInRange(feeBps, "feeBps", 0, 10000);
  return Math.floor((subtotalCents * feeBps + 9999) / 10000);
}
