import { assertSafeIntegerInRange, assertSafePositiveInt } from "./validate";

/** Largest per-unit markup a provider may enter: $1,000.00 (ADR-028, guards typos). */
export const MAX_MARKUP_CENTS = 100000;

/**
 * Derive a patient-facing unit price (integer cents) from the provider's per-unit dollar
 * markup (ADR-028). The patient pays COGS + markup + the platform fee, so the price is
 * grossed up until the fee on it is covered:
 *
 *   price = ceil((unitCogs + max(markup, 1)) * 10000 / (10000 - feeBps))
 *
 * We round UP so the fee never eats into the markup: across an order the provider's net
 * margin is always >= the sum of qty x markup (the half-up order fee can add at most half
 * a cent, which the integer ceiling absorbs). A single line can come out 1 cent below its
 * markup once the order fee is allocated across lines by largest remainder (ADR-003), so a
 * $0 markup is priced as 1 cent: that cent of headroom keeps every line margin >= 0 (the
 * ADR-004 floor) - a $0 line nets 0 or 1 cent, never a loss. Integer math only (ADR-003):
 * the inputs are safe integers and the quotient is ceiled once.
 */
export function priceFromMarkupCents(unitCogsCents: number, markupCents: number, feeBps: number): number {
  assertSafePositiveInt(unitCogsCents, "unitCogsCents");
  assertSafeIntegerInRange(markupCents, "markupCents", 0, MAX_MARKUP_CENTS);
  assertSafeIntegerInRange(feeBps, "feeBps", 0, 9999);
  const pricedMarkup = Math.max(markupCents, 1);
  return Math.ceil(((unitCogsCents + pricedMarkup) * 10000) / (10000 - feeBps));
}
