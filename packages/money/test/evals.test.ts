/**
 * ============================================================================
 *  GATE G1 - HUMAN REVIEW TARGET
 * ============================================================================
 * This file is the test file a human reviewer reads for gate G1. The question
 * for the reviewer: do these rules match docs/DECISIONS.md ADR-001 through
 * ADR-005 (plus ADR-012 / ADR-014 for refund amounts)?
 *
 * Every example test below is named with its EVAL id from docs/EVALS.md and
 * carries a one-line comment citing the DECISION (ADR) it enforces. Expected
 * values are copied EXACTLY from docs/EVALS.md and must never be changed to make
 * a test pass (AGENTS.md section 4). Property tests live in properties.test.ts.
 *
 * The rules under review:
 *   ADR-001  platform fee = 0.75% (75 bps) of the patient-paid subtotal
 *   ADR-002  patient sees no fee line (ADR-028: the fee is built into the price)
 *   ADR-003  integer cents; fee computed once per order, half-up; allocated to
 *            lines by largest remainder (never per-line rounding)
 *   ADR-004  line margin after allocated fee must be >= 0; zero margin allowed
 *   ADR-028  price derives from the provider's per-unit dollar markup:
 *            price = ceil((cogs + markup) * 10000 / (10000 - feeBps))
 *   ADR-012  refund returns 100% to patient; platform fee retained, charged to
 *            the provider
 *   ADR-014  whole-order refunds only
 * ============================================================================
 */
import { describe, expect, it } from "vitest";
import {
  MoneyError,
  allocateFee,
  orderFee,
  priceFromMarkupCents,
  refund,
  split,
  type SplitLineInput,
} from "../src/index";

// Seed COGS values from docs/EVALS.md, used across the scenarios below.
const COGS = {
  MAG_GLY_120: 1450,
  VITD3_K2: 1125,
  OMEGA3_1000: 2280,
} as const;

describe("EVAL-01 - two-line order, fee allocation by largest remainder", () => {
  // ADR-001 (0.75% fee), ADR-003 (half-up once per order, largest-remainder allocation).
  const lines: SplitLineInput[] = [
    { position: 0, qty: 2, unitPriceCents: 2999, unitCogsCents: COGS.MAG_GLY_120 },
    { position: 1, qty: 1, unitPriceCents: 2499, unitCogsCents: COGS.VITD3_K2 },
  ];

  it("EVAL-01: subtotal 8497, cogs 4025, fee 64, line fees [45, 19], line margins [3053, 1355], order margin 4408", () => {
    const result = split(lines);
    expect(result.subtotal).toBe(8497);
    expect(result.cogs).toBe(4025);
    expect(result.fee).toBe(64);
    expect(result.lines.map((l) => l.fee)).toEqual([45, 19]);
    expect(result.lines.map((l) => l.margin)).toEqual([3053, 1355]);
    expect(result.margin).toBe(4408);
  });

  it("EVAL-01: per-line and order identity cogs + fee + margin = total holds", () => {
    // ADR-003: the split must reconcile exactly, with no lost or invented cents.
    const result = split(lines);
    for (const l of result.lines) {
      expect(l.cogs + l.fee + l.margin).toBe(l.total);
    }
    expect(result.cogs + result.fee + result.margin).toBe(result.subtotal);
  });

  it("EVAL-01: line fees sum exactly to the order fee (AI-02 guard)", () => {
    // ADR-003: largest-remainder allocation; line fees must reconcile to the order fee.
    const result = split(lines);
    expect(result.lines.reduce((a, l) => a + l.fee, 0)).toBe(result.fee);
  });
});

describe("EVAL-02 - single line, fee rounds down", () => {
  // ADR-001 (0.75%), ADR-003 (half-up: raw 37.4925 rounds DOWN to 37).
  it("EVAL-02: OMEGA3-1000 x1 @ 4999 -> fee 37, margin 2682", () => {
    const result = split([
      { position: 0, qty: 1, unitPriceCents: 4999, unitCogsCents: COGS.OMEGA3_1000 },
    ]);
    expect(result.fee).toBe(37);
    expect(result.lines[0]?.margin).toBe(2682);
  });
});

describe("EVAL-03 - half-up boundary, fee rounds up", () => {
  // ADR-003: half-up rounding - raw fee of exactly 16.5 cents rounds UP to 17.
  it("EVAL-03: VITD3-K2 x1 @ 2200 -> fee 17, margin 1058", () => {
    const result = split([
      { position: 0, qty: 1, unitPriceCents: 2200, unitCogsCents: COGS.VITD3_K2 },
    ]);
    expect(result.fee).toBe(17);
    expect(result.lines[0]?.margin).toBe(1058);
  });
});

describe("EVAL-04 - margin floor (margin after allocated fee must be >= 0)", () => {
  // ADR-004: a line whose margin after its allocated fee is < 0 is rejected
  // with MARGIN_NEGATIVE naming the line; zero margin is allowed.
  const line = (unitPriceCents: number): SplitLineInput[] => [
    { position: 0, qty: 1, unitPriceCents, unitCogsCents: COGS.VITD3_K2 },
  ];

  it("EVAL-04: @1125 rejected MARGIN_NEGATIVE (margin -8)", () => {
    expect(() => split(line(1125))).toThrowError(MoneyError);
    try {
      split(line(1125));
    } catch (e) {
      const err = e as MoneyError;
      expect(err.code).toBe("MARGIN_NEGATIVE");
      expect(err.details.position).toBe(0); // the offending line is named
      expect(err.details.margin).toBe(-8);
    }
  });

  it("EVAL-04: @1132 rejected MARGIN_NEGATIVE (margin -1)", () => {
    try {
      split(line(1132));
      throw new Error("expected MARGIN_NEGATIVE");
    } catch (e) {
      const err = e as MoneyError;
      expect(err.code).toBe("MARGIN_NEGATIVE");
      expect(err.details.margin).toBe(-1);
    }
  });

  it("EVAL-04: @1133 accepted with margin 0 (zero margin allowed)", () => {
    const result = split(line(1133));
    expect(result.lines[0]?.margin).toBe(0);
  });
});

describe("EVAL-04b - dollar markup derives the price (ADR-028)", () => {
  // The patient pays COGS + markup + fee; the price is grossed up so the fee is covered.
  it("EVAL-04b: MAG-GLY-120 (cogs 1450) + markup 1000 -> unit price 2469, fee 19, margin 1000", () => {
    const price = priceFromMarkupCents(COGS.MAG_GLY_120, 1000, 75);
    expect(price).toBe(2469);
    const result = split([{ position: 0, qty: 1, unitPriceCents: price, unitCogsCents: COGS.MAG_GLY_120 }]);
    expect(result.fee).toBe(19);
    expect(result.margin).toBe(1000);
  });

  it("EVAL-04b: markup 0 sells at cost + fee with 1 cent of rounding headroom (1462, margin 1)", () => {
    const price = priceFromMarkupCents(COGS.MAG_GLY_120, 0, 75);
    expect(price).toBe(1462);
    expect(split([{ position: 0, qty: 1, unitPriceCents: price, unitCogsCents: COGS.MAG_GLY_120 }]).margin).toBe(1);
  });
});

describe("Fee is driven by a parameter, not hard-coded (AGENTS money rule 3)", () => {
  // ADR-001: 75 bps is the snapshotted default; the math must honour a passed rate.
  it("orderFee(8497) defaults to 75 bps -> 64", () => {
    expect(orderFee(8497)).toBe(64);
    expect(orderFee(8497, 75)).toBe(64);
  });

  it("orderFee honours a different feeBps (0 bps -> 0 fee)", () => {
    expect(orderFee(8497, 0)).toBe(0);
  });
});

describe("Largest-remainder allocation - deterministic tie-break by position", () => {
  // ADR-003: ties in remainder are broken by line position ascending (AGENTS rule 4).
  it("two equal lines, one leftover cent -> lower position wins ([8, 7])", () => {
    // subtotal 2000, orderFee 15; each base 7 (rem 1000), leftover 1 -> position 0.
    const fee = orderFee(2000); // 15
    expect(fee).toBe(15);
    const fees = allocateFee(
      [
        { position: 0, total: 1000 },
        { position: 1, total: 1000 },
      ],
      fee,
    );
    expect(fees).toEqual([8, 7]);
    expect(fees[0]! + fees[1]!).toBe(fee);
  });

  it("tie-break respects the position field, not array order", () => {
    // Same two equal lines but supplied with the higher position first; the cent
    // must still go to position 0 (the first array slot here), proving the
    // allocator sorts by `position`, not by input order.
    const fees = allocateFee(
      [
        { position: 3, total: 1000 },
        { position: 0, total: 1000 },
      ],
      15,
    );
    // position 0 is the second array element -> it receives the extra cent.
    expect(fees).toEqual([7, 8]);
  });
});

describe("Refund amounts (ADR-012, ADR-014) - whole-order, fee retained", () => {
  // ADR-012: patient gets 100%; platform fee retained and charged to the provider.
  // ADR-014: whole-order refunds only (we refund the order-level split).
  it("refund of the EVAL-01 order: patient 8497, cogs 4025, providerDebit 4472, feeRetained 64", () => {
    const orderSplit = split([
      { position: 0, qty: 2, unitPriceCents: 2999, unitCogsCents: COGS.MAG_GLY_120 },
      { position: 1, qty: 1, unitPriceCents: 2499, unitCogsCents: COGS.VITD3_K2 },
    ]);
    const r = refund(orderSplit);
    expect(r.patientAmount).toBe(8497); // 100% back to patient (ADR-012)
    expect(r.cogsReturned).toBe(4025);
    expect(r.feeRetained).toBe(64); // fee kept by Cerbo (ADR-012)
    expect(r.providerDebit).toBe(4472); // margin 4408 + fee 64 charged to provider
    // Cross-check against EVAL-09b debits (margin reversal + fee retention).
    expect(r.providerDebit).toBe(orderSplit.margin + orderSplit.fee);
  });
});

describe("Input validation - safe positive integers only (RT-07 / AI-01)", () => {
  // AGENTS.md section 3: no float, no NaN, no string, no unsafe integer may reach
  // the split math. Every violation throws MoneyError INVALID_INPUT.
  const bad: Array<[string, () => unknown]> = [
    ["float price", () => split([{ position: 0, qty: 1, unitPriceCents: 29.99, unitCogsCents: 1000 }])],
    ["string price", () => split([{ position: 0, qty: 1, unitPriceCents: "2999" as unknown as number, unitCogsCents: 1000 }])],
    ["NaN price", () => split([{ position: 0, qty: 1, unitPriceCents: NaN, unitCogsCents: 1000 }])],
    ["zero qty", () => split([{ position: 0, qty: 0, unitPriceCents: 2999, unitCogsCents: 1000 }])],
    ["negative cogs", () => split([{ position: 0, qty: 1, unitPriceCents: 2999, unitCogsCents: -1 }])],
    ["unsafe integer price", () => split([{ position: 0, qty: 1, unitPriceCents: Number.MAX_SAFE_INTEGER + 1, unitCogsCents: 1000 }])],
    ["empty order", () => split([])],
    ["fee on zero subtotal", () => orderFee(0)],
    ["markup above $1,000", () => priceFromMarkupCents(1450, 100001, 75)],
    ["negative markup", () => priceFromMarkupCents(1450, -1, 75)],
    ["decimal markup", () => priceFromMarkupCents(1450, 10.5, 75)],
    ["feeBps 10000 (div by zero)", () => priceFromMarkupCents(1450, 1000, 10000)],
  ];

  for (const [name, fn] of bad) {
    it(`rejects ${name} with INVALID_INPUT`, () => {
      try {
        fn();
        throw new Error("expected MoneyError INVALID_INPUT");
      } catch (e) {
        expect(e).toBeInstanceOf(MoneyError);
        expect((e as MoneyError).code).toBe("INVALID_INPUT");
      }
    });
  }
});
