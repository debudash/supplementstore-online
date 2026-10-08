// priceOrder (ADR-028): the provider prices each line with a per-unit dollar markup; the
// patient total is COGS + markup grossed up for the 0.75% fee and rounded ONCE per order;
// the fee is 0.75% of that total rounded up ONCE. The property test proves the claims an
// audit relies on, for random orders: no rounding is left over (the provider nets exactly
// qty x markup on every line), the stored line fees add up to the order fee and are each the
// line's exact 0.75% rounded down or up, and the total is the smallest that covers the need.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { priceOrder, orderFee, MAX_MARKUP_CENTS, MoneyError } from "../src";

describe("priceOrder", () => {
  it("rounds the patient total once: the screenshot order is $545.50, fee $4.10, provider $317.00", () => {
    const r = priceOrder([
      { position: 1, qty: 3, unitCogsCents: 2280, markupCents: 1000 }, // Omega-3
      { position: 2, qty: 3, unitCogsCents: 1450, markupCents: 2900 }, // Magnesium
      { position: 3, qty: 10, unitCogsCents: 1125, markupCents: 2000 }, // Vitamin D3
    ]);
    expect([r.subtotal, r.cogs, r.fee, r.margin]).toEqual([54550, 22440, 410, 31700]);
    expect(r.lines.map((l) => [l.total, l.fee, l.margin])).toEqual([
      [9915, 75, 3000],
      [13149, 99, 8700],
      [31486, 236, 20000],
    ]);
    // 31486 / 10 = 3148.6 -> shown as an average unit price of 3149.
    expect(r.lines.map((l) => [l.unitPriceCents, l.unitPriceIsAverage])).toEqual([
      [3305, false],
      [4383, false],
      [3149, true],
    ]);
  });

  it("a $0 markup sells at cost + fee and nets exactly 0", () => {
    const r = priceOrder([{ position: 0, qty: 1, unitCogsCents: 1125, markupCents: 0 }]);
    expect([r.subtotal, r.fee, r.margin]).toEqual([1134, 9, 0]);
  });

  it("rejects a markup above $1,000", () => {
    expect(() => priceOrder([{ position: 0, qty: 1, unitCogsCents: 1450, markupCents: MAX_MARKUP_CENTS + 1 }])).toThrow(MoneyError);
  });

  it("random orders: every cent named, no rounding left over, fees within 1 cent of exact", () => {
    const lineArb = fc.record({
      qty: fc.integer({ min: 1, max: 100 }),
      cogs: fc.integer({ min: 1, max: 100_000 }),
      // Biased toward the edges: $0, small, and anything up to the cap.
      markup: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 10 }), fc.integer({ min: 0, max: MAX_MARKUP_CENTS })),
    });
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 8 }), (lines) => {
        const r = priceOrder(lines.map((l, i) => ({ position: i, qty: l.qty, unitCogsCents: l.cogs, markupCents: l.markup })));
        const need = lines.reduce((a, l) => a + l.qty * (l.cogs + l.markup), 0);
        // Rounded once and minimal: the smallest whole-cent total whose fee is covered.
        expect(r.subtotal - need).toBe(r.fee);
        expect(r.fee).toBe(orderFee(r.subtotal));
        expect(r.subtotal - 1 - orderFee(r.subtotal - 1)).toBeLessThan(need);
        // Lines add up to the order, and each line is cogs + fee + exactly qty x markup.
        expect(r.lines.reduce((a, l) => a + l.total, 0)).toBe(r.subtotal);
        expect(r.lines.reduce((a, l) => a + l.fee, 0)).toBe(r.fee);
        r.lines.forEach((pl, i) => {
          const l = lines[i]!;
          expect(pl.margin).toBe(l.qty * l.markup);
          expect(pl.cogs + pl.fee + pl.margin).toBe(pl.total);
          // The stored line fee is the line's exact 0.75% rounded down or up.
          expect(pl.fee).toBeGreaterThanOrEqual(Math.floor((pl.total * 75) / 10000));
          expect(pl.fee).toBeLessThanOrEqual(Math.ceil((pl.total * 75) / 10000));
          expect(pl.fee).toBeGreaterThanOrEqual(0);
        });
      }),
      { numRuns: 10_000 },
    );
  });
});
