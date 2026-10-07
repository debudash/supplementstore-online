import { assertSafeIntegerInRange, assertSafeNonNegativeInt } from "./validate";

/**
 * Unit-economics helpers for the admin Evidence page. These ESTIMATE costs that are not
 * charged anywhere in the product (card processing is outside this slice); they exist so
 * the business case is computed in one audited place instead of in a view.
 *
 * Integer cents and basis points only; half-up rounding to match orderFee (ADR-003).
 */

/** Typical US card-processing assumption: 2.9% + 30 cents per charge. */
export const DEFAULT_PROCESSING_RATE_BPS = 290;
export const DEFAULT_PROCESSING_FIXED_CENTS = 30;
/** Upper bounds that keep the products below safe-integer range and reject nonsense. */
const MAX_RATE_BPS = 10_000;
const MAX_FIXED_CENTS = 100_000;
const MAX_AMOUNT_CENTS = Math.floor(Number.MAX_SAFE_INTEGER / MAX_RATE_BPS);

/**
 * Estimated processing cost of ONE charge: half-up(amount x rateBps / 10000) + fixed.
 * A zero amount (nothing charged) costs nothing.
 */
export function processingCostCents(
  amountCents: number,
  rateBps: number = DEFAULT_PROCESSING_RATE_BPS,
  fixedCents: number = DEFAULT_PROCESSING_FIXED_CENTS,
): number {
  assertSafeIntegerInRange(amountCents, "amountCents", 0, MAX_AMOUNT_CENTS);
  assertSafeIntegerInRange(rateBps, "rateBps", 0, MAX_RATE_BPS);
  assertSafeIntegerInRange(fixedCents, "fixedCents", 0, MAX_FIXED_CENTS);
  if (amountCents === 0) return 0;
  return Math.floor((amountCents * rateBps + 5000) / 10000) + fixedCents;
}

/**
 * The smallest platform fee, in basis points, that covers the estimated processing cost of
 * an order of `orderCents`: ceil(processingCost x 10000 / orderCents). Rounded UP so the
 * suggested fee is never short. Throws for a zero order (no meaningful break-even).
 */
export function breakevenFeeBps(
  orderCents: number,
  rateBps: number = DEFAULT_PROCESSING_RATE_BPS,
  fixedCents: number = DEFAULT_PROCESSING_FIXED_CENTS,
): number {
  assertSafeIntegerInRange(orderCents, "orderCents", 1, MAX_AMOUNT_CENTS);
  const cost = processingCostCents(orderCents, rateBps, fixedCents);
  return Math.ceil((cost * 10000) / orderCents);
}

/** Floor average of a non-negative cents total over a count; 0 when the count is 0. */
export function averageCents(totalCents: number, count: number): number {
  assertSafeIntegerInRange(totalCents, "totalCents", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  assertSafeNonNegativeInt(count, "count");
  if (count === 0) return 0;
  return Math.floor(totalCents / count);
}
