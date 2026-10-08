/**
 * EVAL-P1 - property tests (fast-check, 10,000 runs each).
 *
 * These exist to catch RED_TEAM AI-02 (per-line fee rounding instead of order-level
 * largest-remainder allocation) and to prove the ADR-003 invariants hold for random
 * orders, not just the hand-picked EVAL examples:
 *
 *   - line fees sum EXACTLY to the order fee              (AI-02)
 *   - per line: cogs + fee + margin = total              (ADR-003)
 *   - order fee = subtotal x 0.0075 rounded UP           (ADR-001/028)
 *   - allocation is deterministic                        (ADR-003)
 *   - when split succeeds, every line margin >= 0        (ADR-004)
 *
 * Values are bounded so all products stay within Number.MAX_SAFE_INTEGER.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MoneyError, allocateFee, orderFee, split, type SplitLineInput } from "../src/index";

const RUNS = { numRuns: 10_000 } as const;

/** Independent BigInt oracle for the rounded-up order fee (no reuse of production code). */
function feeOracle(subtotal: number, feeBps = 75): number {
  return Number((BigInt(subtotal) * BigInt(feeBps) + 9999n) / 10000n);
}

// qty 1..100 and prices up to 10_000_000 cents keep subtotal <= 1e10 (safe).
const qtyArb = fc.integer({ min: 1, max: 100 });
const priceArb = fc.integer({ min: 1, max: 10_000_000 });

describe("EVAL-P1: allocateFee reconciles exactly (direct AI-02 guard)", () => {
  // Arbitrary positive line totals + the real order fee: line fees must always
  // sum to the order fee. Per-line rounding would break this.
  const totalsArb = fc.array(fc.integer({ min: 1, max: 1_000_000_000 }), {
    minLength: 1,
    maxLength: 10,
  });

  it("line fees sum exactly to the order fee, are non-negative, and allocation is deterministic", () => {
    fc.assert(
      fc.property(totalsArb, (totals) => {
        const subtotal = totals.reduce((a, b) => a + b, 0);
        const fee = orderFee(subtotal);
        const lines = totals.map((total, i) => ({ position: i, total }));

        const fees = allocateFee(lines, fee);
        const second = allocateFee(lines, fee);

        expect(fees.reduce((a, b) => a + b, 0)).toBe(fee); // exact reconciliation
        expect(fees.every((f) => f >= 0)).toBe(true);
        expect(fees).toEqual(second); // deterministic
      }),
      RUNS,
    );
  });
});

describe("EVAL-P1: orderFee is the subtotal's fee rounded up", () => {
  it("matches an independent BigInt round-up oracle", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000_000 }), (subtotal) => {
        expect(orderFee(subtotal)).toBe(feeOracle(subtotal));
      }),
      RUNS,
    );
  });
});

describe("EVAL-P1: split holds all invariants for random orders (prices >= cogs)", () => {
  // EVAL-P1 input shape: 1..10 lines, qty 1..100, prices >= cogs.
  const lineArb = fc
    .record({
      qty: qtyArb,
      unitCogsCents: priceArb,
      markup: fc.integer({ min: 0, max: 10_000_000 }),
    })
    .map(({ qty, unitCogsCents, markup }) => ({
      qty,
      unitCogsCents,
      unitPriceCents: unitCogsCents + markup, // guarantees price >= cogs
    }));

  const orderArb = fc
    .array(lineArb, { minLength: 1, maxLength: 10 })
    .map((lines): SplitLineInput[] =>
      lines.map((l, i) => ({
        position: i,
        qty: l.qty,
        unitPriceCents: l.unitPriceCents,
        unitCogsCents: l.unitCogsCents,
      })),
    );

  it("either rejects with MARGIN_NEGATIVE or returns a fully-reconciled split with margin >= 0", () => {
    fc.assert(
      fc.property(orderArb, (lines) => {
        let result;
        try {
          result = split(lines);
        } catch (e) {
          // The only acceptable rejection here is the ADR-004 margin floor.
          expect(e).toBeInstanceOf(MoneyError);
          expect((e as MoneyError).code).toBe("MARGIN_NEGATIVE");
          return;
        }

        // Order fee is the subtotal's fee rounded up (ADR-001/028).
        expect(result.fee).toBe(feeOracle(result.subtotal));

        // Line fees reconcile exactly to the order fee (AI-02).
        expect(result.lines.reduce((a, l) => a + l.fee, 0)).toBe(result.fee);

        // Per-line identity and non-negative margin (ADR-003 / ADR-004).
        for (const l of result.lines) {
          expect(l.cogs + l.fee + l.margin).toBe(l.total);
          expect(l.margin).toBeGreaterThanOrEqual(0);
        }

        // Order-level identity.
        expect(result.cogs + result.fee + result.margin).toBe(result.subtotal);

        // Determinism: same input -> identical split.
        expect(split(lines)).toEqual(result);
      }),
      RUNS,
    );
  });
});
