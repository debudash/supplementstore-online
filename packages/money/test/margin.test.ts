// marginBpsFromPrice: the inverse of priceFromMarginBps, used to SHOW the margin a list
// price represents (admin price editor, provider "margin at list price"). It never feeds
// a charge. New file - it does not modify the existing protected evals/properties tests.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { marginBpsFromPrice, priceFromMarginBps, MAX_MARGIN_BPS, MoneyError } from "../src";

describe("marginBpsFromPrice", () => {
  it("matches the seeded catalog examples (floor, never overstated)", () => {
    // MAG-GLY-120: cogs 1450, list 2999 -> (1549 * 10000) / 2999 = 5165.05 -> 5165
    expect(marginBpsFromPrice(1450, 2999)).toBe(5165);
    // PROBIO-50B: cogs 2675, list 4299 -> 3777.6 -> 3777
    expect(marginBpsFromPrice(2675, 4299)).toBe(3777);
    expect(marginBpsFromPrice(1000, 2000)).toBe(5000);
  });

  it("is zero at cost and negative below cost", () => {
    expect(marginBpsFromPrice(1450, 1450)).toBe(0);
    // (1000 - 1450) * 10000 / 1000 = -4500
    expect(marginBpsFromPrice(1450, 1000)).toBe(-4500);
    // floor rounds toward negative infinity: (3 - 5) * 10000 / 3 = -6666.67 -> -6667
    expect(marginBpsFromPrice(5, 3)).toBe(-6667);
  });

  it("rejects unsafe or non-positive input", () => {
    expect(() => marginBpsFromPrice(0, 100)).toThrow(MoneyError);
    expect(() => marginBpsFromPrice(100, 0)).toThrow(MoneyError);
    expect(() => marginBpsFromPrice(100, 29.99)).toThrow(MoneyError);
    expect(() => marginBpsFromPrice(100, Number.MAX_SAFE_INTEGER)).toThrow(MoneyError);
  });

  it("round-trips with priceFromMarginBps: the derived price never shows LESS margin than asked", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 0, max: MAX_MARGIN_BPS }), (cogs, bps) => {
        const price = priceFromMarginBps(cogs, bps);
        const shown = marginBpsFromPrice(cogs, price);
        expect(shown).toBeGreaterThanOrEqual(bps);
        expect(Number.isSafeInteger(shown)).toBe(true);
      })
    );
  });
});
