import { assertSafeIntegerInRange, assertSafePositiveInt } from "./validate";

/** Maximum margin percent, in basis points, accepted in margin-% pricing mode. */
export const MAX_MARGIN_BPS = 9500;

/**
 * Derive a patient-facing unit price (integer cents) from a target margin percent.
 *
 * ADR-005 / FR-2 AC1: price is the canonical stored value; margin % is an input
 * mode that derives it. Margin % is defined as (price - cogs) / price, so:
 *
 *   price = ceil(unitCogs * 10000 / (10000 - marginBps))
 *
 * We round UP so the realised margin is at least the requested margin, never below
 * it. `marginBps` is in [0, 9500] (FR-2 AC1); 10000 would divide by zero and is
 * rejected as INVALID_INPUT. Integer math only (ADR-003): no float division.
 */
export function priceFromMarginBps(unitCogsCents: number, marginBps: number): number {
  assertSafePositiveInt(unitCogsCents, "unitCogsCents");
  assertSafeIntegerInRange(marginBps, "marginBps", 0, MAX_MARGIN_BPS);
  return Math.ceil((unitCogsCents * 10000) / (10000 - marginBps));
}

/** Largest price (cents) for which `(price - cogs) * 10000` stays a safe integer. */
export const MAX_PRICE_FOR_MARGIN_CENTS = Math.floor(Number.MAX_SAFE_INTEGER / 10000);

/**
 * The gross margin, in basis points, that a unit price represents over its COGS - the
 * inverse of priceFromMarginBps, using the same definition (price - cogs) / price.
 *
 *   marginBps = floor((price - cogs) * 10000 / price)
 *
 * Rounded DOWN (toward negative infinity) so a displayed margin is never overstated.
 * Negative when the price is below cost. This is a gross figure BEFORE the platform
 * fee; it is shown to people as context, never used to compute a charge.
 */
export function marginBpsFromPrice(unitCogsCents: number, unitPriceCents: number): number {
  assertSafePositiveInt(unitCogsCents, "unitCogsCents");
  assertSafeIntegerInRange(unitPriceCents, "unitPriceCents", 1, MAX_PRICE_FOR_MARGIN_CENTS);
  return Math.floor(((unitPriceCents - unitCogsCents) * 10000) / unitPriceCents);
}
