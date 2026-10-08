// priceFromMarkupCents (ADR-028): the provider's per-unit dollar markup plus COGS, grossed
// up so the 0.75% fee is covered. The property test proves the provider keeps what they
// typed: order margin >= sum(qty x markup), a line is never below its markup by more than
// the 1 cent that largest-remainder fee allocation can move, and - because a $0 markup is
// priced as 1 cent - no line is ever negative (ADR-004).
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { priceFromMarkupCents, MAX_MARKUP_CENTS, split, MoneyError, markupBreakdown, maxRoundingCents } from "../src";

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
        // Every cent is named: total = cogs + fee + markup + rounding, and the order's
        // rounding is never negative and within the pricing rule's bound.
        const b = markupBreakdown(result.lines.map((sl, i) => ({ qty: lines[i].qty, unitMarkupCents: lines[i].markup, marginCents: sl.margin })));
        result.lines.forEach((sl, i) => {
          const bl = b.lines[i]!;
          expect(sl.cogs + sl.fee + bl.markupCents + bl.roundingCents).toBe(sl.total);
        });
        expect(b.markupCents).toBe(typed);
        expect(b.roundingCents).toBeGreaterThanOrEqual(0);
        expect(b.roundingCents).toBeLessThanOrEqual(maxRoundingCents(lines.map((l) => ({ qty: l.qty, unitMarkupCents: l.markup }))));
      }),
      { numRuns: 10_000 },
    );
  });

  it("names every cent of the EVAL-01 order: $84.97 = cost 40.25 + fee 0.64 + markup 44.07 + rounding 0.01", () => {
    const r = split([
      { position: 1, qty: 2, unitPriceCents: priceFromMarkupCents(1450, 1526, 75), unitCogsCents: 1450 },
      { position: 2, qty: 1, unitPriceCents: priceFromMarkupCents(1125, 1355, 75), unitCogsCents: 1125 },
    ]);
    const b = markupBreakdown([
      { qty: 2, unitMarkupCents: 1526, marginCents: r.lines[0].margin },
      { qty: 1, unitMarkupCents: 1355, marginCents: r.lines[1].margin },
    ]);
    expect([r.subtotal, r.cogs, r.fee, b.markupCents, b.roundingCents]).toEqual([8497, 4025, 64, 4407, 1]);
    expect(b.lines).toEqual([{ markupCents: 3052, roundingCents: 1 }, { markupCents: 1355, roundingCents: 0 }]);
  });

  it("a line priced before markup tracking has no breakdown", () => {
    expect(markupBreakdown([{ qty: 1, unitMarkupCents: null, marginCents: 500 }])).toEqual({ lines: [null], markupCents: null, roundingCents: null });
  });
});
