import { MoneyError } from "./errors";
import { DEFAULT_FEE_BPS, orderFee } from "./fee";
import { MAX_MARKUP_CENTS } from "./pricing";
import { assertSafeIntegerInRange, assertSafeNonNegativeInt, assertSafePositiveInt } from "./validate";

/** One order line priced from the provider's markup (ADR-028). */
export interface MarkupLineInput {
  /** Line position within the order; breaks ties when cents are handed out (ascending). */
  position: number;
  qty: number;
  /** Cerbo's unit COGS in cents (> 0). */
  unitCogsCents: number;
  /** The provider's per-unit markup in cents, 0..MAX_MARKUP_CENTS. */
  markupCents: number;
}

/** A priced line. total = cogs + fee + margin, and margin = qty x markup exactly. */
export interface PricedLine {
  position: number;
  total: number;
  cogs: number;
  fee: number;
  margin: number;
  /** total / qty rounded half-up to the cent, for display; the line total is what is charged. */
  unitPriceCents: number;
  /** True when total is not qty x a whole-cent price, so unitPriceCents is an average. */
  unitPriceIsAverage: boolean;
}

export interface PricedOrder {
  feeBps: number;
  subtotal: number;
  cogs: number;
  fee: number;
  margin: number;
  lines: PricedLine[];
}

/**
 * Price a whole order from each line's COGS and the provider's markup (ADR-028), rounding
 * ONCE at the order level:
 *
 *   1. need     = sum(qty x (cogs + markup))            what cost + markup require
 *   2. subtotal = ceil(need x 10000 / (10000 - feeBps))  the patient total, rounded up once
 *   3. fee      = orderFee(subtotal)                     0.75% rounded up to the cent, once
 *   4. line totals: the subtotal split across lines by largest remainder of each line's
 *      exact share, so the lines add up to the subtotal to the cent
 *   5. line fee = line total - line cogs - qty x markup
 *
 * Because the subtotal and the fee are both rounded UP, subtotal - need is exactly the
 * fee: there is no rounding left over for anyone, the provider receives exactly
 * qty x markup on every line, and each stored line fee is its exact 0.75% rounded down or
 * up (within 1 cent), never negative, adding up to the order fee. A line whose total is not
 * divisible by its quantity shows an average unit price; the line total is authoritative.
 * Integer math only (ADR-003).
 */
export function priceOrder(lines: MarkupLineInput[], feeBps: number = DEFAULT_FEE_BPS): PricedOrder {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new MoneyError("INVALID_INPUT", "an order must have at least one line");
  }
  assertSafeIntegerInRange(feeBps, "feeBps", 0, 9999);
  const denom = 10000 - feeBps;

  let need = 0;
  let cogsTotal = 0;
  const shares = lines.map((l) => {
    assertSafeNonNegativeInt(l.position, "position");
    assertSafePositiveInt(l.qty, "qty");
    assertSafePositiveInt(l.unitCogsCents, "unitCogsCents");
    assertSafeIntegerInRange(l.markupCents, "markupCents", 0, MAX_MARKUP_CENTS);
    const lineNeed = l.qty * (l.unitCogsCents + l.markupCents);
    need += lineNeed;
    cogsTotal += l.qty * l.unitCogsCents;
    const num = lineNeed * 10000;
    return { position: l.position, lineNeed, base: Math.floor(num / denom), rem: num % denom };
  });

  const subtotal = Math.floor((need * 10000 + denom - 1) / denom);
  const fee = orderFee(subtotal, feeBps);
  if (subtotal - need !== fee) {
    // Proven to hold (both roundings are up); a failure here is a programming error.
    throw new MoneyError("INVALID_INPUT", "internal: order price and fee do not reconcile", { subtotal, need, fee });
  }

  // Hand the cents left after flooring each line's exact share to the largest remainders.
  const totals = shares.map((s) => s.base);
  let leftover = subtotal - totals.reduce((a, b) => a + b, 0);
  const order = shares
    .map((s, i) => ({ i, rem: s.rem, position: s.position }))
    .sort((a, b) => (b.rem !== a.rem ? b.rem - a.rem : a.position - b.position));
  for (const o of order) {
    if (leftover <= 0) break;
    totals[o.i] = (totals[o.i] as number) + 1;
    leftover -= 1;
  }

  const out: PricedLine[] = lines.map((l, i) => {
    const total = totals[i] as number;
    const cogs = l.qty * l.unitCogsCents;
    const margin = l.qty * l.markupCents;
    const lineFee = total - cogs - margin;
    if (lineFee < 0) {
      throw new MoneyError("INVALID_INPUT", "internal: negative line fee", { position: l.position, total, cogs, margin });
    }
    return {
      position: l.position,
      total,
      cogs,
      fee: lineFee,
      margin,
      unitPriceCents: Math.floor((2 * total + l.qty) / (2 * l.qty)),
      unitPriceIsAverage: total % l.qty !== 0,
    };
  });

  return { feeBps, subtotal, cogs: cogsTotal, fee, margin: need - cogsTotal, lines: out };
}
