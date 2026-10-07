// Unit-economics estimates for the admin Evidence page (new file; the existing protected
// evals/properties tests are untouched).
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { processingCostCents, breakevenFeeBps, averageCents, orderFee, MoneyError } from "../src";

describe("processingCostCents", () => {
  it("defaults to 2.9% + 30c, half-up", () => {
    // 8497 x 290 / 10000 = 246.41 -> 246, + 30 = 276
    expect(processingCostCents(8497)).toBe(276);
    // 2999 x 290 / 10000 = 86.97 -> 87, + 30 = 117
    expect(processingCostCents(2999)).toBe(117);
    // 50 x 290 / 10000 = 1.45 -> 1 (half-up of 1.45), + 30 = 31
    expect(processingCostCents(50)).toBe(31);
    expect(processingCostCents(0)).toBe(0);
  });

  it("accepts custom rates and rejects unsafe input", () => {
    expect(processingCostCents(10000, 200, 0)).toBe(200);
    expect(() => processingCostCents(-1)).toThrow(MoneyError);
    expect(() => processingCostCents(29.99)).toThrow(MoneyError);
    expect(() => processingCostCents(100, 10001)).toThrow(MoneyError);
  });
});

describe("breakevenFeeBps", () => {
  it("is the smallest fee that covers processing (rounded up)", () => {
    // cost 276 on 8497 -> 276 x 10000 / 8497 = 324.8 -> 325 bps (3.25%)
    expect(breakevenFeeBps(8497)).toBe(325);
    expect(() => breakevenFeeBps(0)).toThrow(MoneyError);
  });

  it("property: a fee at the break-even rate always covers processing", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 5_000_000 }), (order) => {
        const bps = breakevenFeeBps(order);
        expect(orderFee(order, bps) + 1).toBeGreaterThanOrEqual(processingCostCents(order));
      })
    );
  });
});

describe("averageCents", () => {
  it("floors and handles zero counts", () => {
    expect(averageCents(10, 3)).toBe(3);
    expect(averageCents(0, 0)).toBe(0);
    expect(averageCents(-64, 1)).toBe(-64);
    expect(() => averageCents(10, -1)).toThrow(MoneyError);
  });
});
