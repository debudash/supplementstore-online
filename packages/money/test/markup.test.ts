// priceFromMarkupCents (ADR-028): the provider's per-unit dollar markup plus COGS, grossed
// up so the 0.75% fee is covered. The property test proves the provider keeps what they
// typed: order margin >= sum(qty x markup), a line is never below its markup by more than
// the 1 cent that largest-remainder fee allocation can move, and - because a $0 markup is
// priced as 1 cent - no line is ever negative (ADR-004).
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { priceFromMarkupCents, MAX_MARKUP_CENTS, split, MoneyError } from "../src";

describe("priceFromMarkupCents", () => {
  it("grosses COGS + markup up by the fee and rounds up to the cent", () => {
    // (1450 + 1000) * 10000 / 9925 = 2468.51 -> 2469
    expect(priceFromMarkupCents(1450, 1000, 75)).toBe(2469);
    // markup 0 is priced as 1 cent of headroom: (2675 + 1) * 10000 / 9925 = 2696.22 -> 2697
    expect(priceFromMarkupCents(2675, 0, 75)).toBe(2697);
    // with no fee the price is exactly COGS + markup
    expect(priceFromMarkupCents(1450, 1000, 0)).toBe(2450);
  });

  it("accepts the $1,000 cap and rejects anything above it", () => {
    expect(priceFromMarkupCents(1450, MAX_MARKUP_CENTS, 75)).toBe(Math.ceil((101450 * 10000) / 9925));
    expect(() => priceFromMarkupCents(1450, MAX_MARKUP_CENTS + 1, 75)).toThrow(MoneyError);
  });

  it("a $0 line never goes negative when fee allocation moves a cent onto it", () => {
    // Regression: priced at a bare 0 markup this order allocated -1 cent to line 3.
    const lines: Array<[number, number]> = [[4796, 1], [156, 7], [3308, 7]];
    const result = split(
      lines.map(([cogs, qty], i) => ({ position: i + 1, qty, unitCogsCents: cogs, unitPriceCents: priceFromMarkupCents(cogs, 0, 75) })),
    );
    for (const l of result.lines) expect(l.margin).toBeGreaterThanOrEqual(0);
  });

  it("the provider keeps the markup they typed (order level exact-or-better, line within 1 cent)", () => {
    const lineArb = fc.record({
      qty: fc.integer({ min: 1, max: 100 }),
      cogs: fc.integer({ min: 1, max: 100_000 }),
      // Biased toward the edges: $0 (the rounding-headroom case), small, and anything.
      markup: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 10 }), fc.integer({ min: 0, max: MAX_MARKUP_CENTS })),
    });
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 8 }), (lines) => {
        const result = split(
          lines.map((l, i) => ({
            position: i,
            qty: l.qty,
            unitPriceCents: priceFromMarkupCents(l.cogs, l.markup, 75),
            unitCogsCents: l.cogs,
          })),
        );
        const typed = lines.reduce((a, l) => a + l.qty * l.markup, 0);
        expect(result.margin).toBeGreaterThanOrEqual(typed);
        result.lines.forEach((sl, i) => {
          expect(sl.margin).toBeGreaterThanOrEqual(lines[i].qty * lines[i].markup - 1);
          expect(sl.margin).toBeGreaterThanOrEqual(0);
        });
      }),
      { numRuns: 10_000 },
    );
  });
});
