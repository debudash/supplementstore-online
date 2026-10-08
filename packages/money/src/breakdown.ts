import { assertSafeIntegerInRange, assertSafePositiveInt } from "./validate";

/** One line's provider share split into what they typed and the price rounding. */
export interface MarkupBreakdownLine {
  /** qty x the provider's per-unit markup. */
  markupCents: number;
  /** The line's net margin minus its markup: the cent(s) left by rounding the price up to
   *  the cent (ADR-028). Can be -1 on one line after largest-remainder fee allocation. */
  roundingCents: number;
}

/** Where a markup-priced order's provider share came from (ADR-028). */
export interface MarkupBreakdown {
  lines: Array<MarkupBreakdownLine | null>;
  /** Sum of line markups; null if any line has no markup (priced before ADR-028). */
  markupCents: number | null;
  /** Sum of line roundings; null if any line has no markup. */
  roundingCents: number | null;
}

/**
 * Split each line's provider net margin into the markup the provider typed and the price
 * rounding (ADR-028), so an audit can name every cent:
 *
 *   line total = cogs + fee + markup + rounding
 *
 * The platform fee is exactly 0.75% of the order (ADR-001); the unit price is rounded UP
 * to the cent, and that rounding goes to the provider as the price-setter. Across an order
 * the rounding is never negative and under 1 cent per unit (2 cents on a $0 line, which is
 * priced with 1 cent of headroom). Lines priced before ADR-028 (no markup) yield null.
 */
export function markupBreakdown(
  lines: Array<{ qty: number; unitMarkupCents: number | null; marginCents: number }>,
): MarkupBreakdown {
  let markupCents: number | null = 0;
  let roundingCents: number | null = 0;
  const out = lines.map((l) => {
    assertSafePositiveInt(l.qty, "qty");
    assertSafeIntegerInRange(l.marginCents, "marginCents", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (l.unitMarkupCents === null) {
      markupCents = null;
      roundingCents = null;
      return null;
    }
    assertSafeIntegerInRange(l.unitMarkupCents, "unitMarkupCents", 0, Number.MAX_SAFE_INTEGER);
    const markup = l.qty * l.unitMarkupCents;
    const rounding = l.marginCents - markup;
    if (markupCents !== null && roundingCents !== null) {
      markupCents += markup;
      roundingCents += rounding;
    }
    return { markupCents: markup, roundingCents: rounding };
  });
  return { lines: out, markupCents, roundingCents };
}

/** Largest order-level rounding the pricing rule can leave: 1 cent per unit, 2 on a $0 line. */
export function maxRoundingCents(lines: Array<{ qty: number; unitMarkupCents: number }>): number {
  return lines.reduce((a, l) => a + l.qty * (l.unitMarkupCents === 0 ? 2 : 1), 0);
}
