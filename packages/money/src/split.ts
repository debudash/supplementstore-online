import { allocateFee } from "./allocate";
import { MoneyError } from "./errors";
import { DEFAULT_FEE_BPS, orderFee } from "./fee";
import { assertSafeNonNegativeInt, assertSafePositiveInt } from "./validate";

/** One order line as priced by the provider (snapshot values, integer cents). */
export interface SplitLineInput {
  /** Line position within the order; breaks fee-allocation ties (ascending). */
  position: number;
  /** Units ordered (>= 1). */
  qty: number;
  /** Patient-facing unit price in cents (> 0). */
  unitPriceCents: number;
  /** Cerbo's unit COGS in cents (> 0), snapshotted at send (ADR-006). */
  unitCogsCents: number;
}

/** The computed split for a single line. Satisfies total = cogs + fee + margin. */
export interface SplitLine {
  position: number;
  total: number;
  cogs: number;
  fee: number;
  margin: number;
}

/** The computed split for the whole order. */
export interface OrderSplit {
  feeBps: number;
  subtotal: number;
  cogs: number;
  fee: number;
  margin: number;
  lines: SplitLine[];
}

/**
 * Compute the full money split for an order, integer cents only.
 *
 * Pipeline (ADR-001/003/004):
 *   1. line total = qty * unitPriceCents;  line cogs = qty * unitCogsCents
 *   2. subtotal = sum of line totals
 *   3. order fee = orderFee(subtotal, feeBps)  -- half-up, once per order
 *   4. allocate the order fee across lines by largest remainder
 *   5. line margin = total - cogs - fee
 *
 * ADR-004 / FR-2 AC3: if ANY line's margin after its allocated fee is < 0, the
 * whole split is rejected with MoneyError("MARGIN_NEGATIVE") naming the first
 * offending line position. Zero margin is allowed.
 *
 * Invariants guaranteed when this returns:
 *   - per line and for the order:  cogs + fee + margin = total
 *   - every line margin >= 0
 *   - sum of line fees = order fee   (no per-line rounding drift; AI-02)
 */
export function split(lines: SplitLineInput[], feeBps: number = DEFAULT_FEE_BPS): OrderSplit {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new MoneyError("INVALID_INPUT", "an order must have at least one line");
  }

  // Step 1 + validation: every input is a safe positive integer (position >= 0).
  const totals: number[] = [];
  const cogses: number[] = [];
  for (const line of lines) {
    assertSafeNonNegativeInt(line.position, "position");
    assertSafePositiveInt(line.qty, "qty");
    assertSafePositiveInt(line.unitPriceCents, "unitPriceCents");
    assertSafePositiveInt(line.unitCogsCents, "unitCogsCents");
    totals.push(line.qty * line.unitPriceCents);
    cogses.push(line.qty * line.unitCogsCents);
  }

  // Step 2 + 3.
  const subtotal = totals.reduce((a, b) => a + b, 0);
  const totalCogs = cogses.reduce((a, b) => a + b, 0);
  const fee = orderFee(subtotal, feeBps);

  // Step 4: allocate the single order fee across lines (largest remainder).
  const lineFees = allocateFee(
    lines.map((line, i) => ({ position: line.position, total: totals[i] as number })),
    fee,
  );

  // Step 5: build per-line splits and enforce the margin floor (ADR-004).
  const outLines: SplitLine[] = lines.map((line, i) => {
    const total = totals[i] as number;
    const cogs = cogses[i] as number;
    const lineFee = lineFees[i] as number;
    const margin = total - cogs - lineFee;
    if (margin < 0) {
      throw new MoneyError(
        "MARGIN_NEGATIVE",
        `line at position ${line.position} has negative margin after its allocated fee`,
        { position: line.position, total, cogs, fee: lineFee, margin },
      );
    }
    return { position: line.position, total, cogs, fee: lineFee, margin };
  });

  const orderMargin = outLines.reduce((a, l) => a + l.margin, 0);

  return {
    feeBps,
    subtotal,
    cogs: totalCogs,
    fee,
    margin: orderMargin,
    lines: outLines,
  };
}
