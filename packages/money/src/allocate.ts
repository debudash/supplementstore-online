import { assertSafeNonNegativeInt, assertSafePositiveInt } from "./validate";

/** A line as seen by fee allocation: its order position and its total in cents. */
export interface AllocationLine {
  /** Line position within the order; used only to break remainder ties. */
  position: number;
  /** Line total in integer cents (qty * unitPriceCents), strictly positive. */
  total: number;
}

/**
 * Allocate an order-level fee across its lines using the LARGEST REMAINDER method,
 * integer math only (ADR-003).
 *
 * For each line i (with subtotal = sum of all line totals):
 *   num_i  = orderFee * total_i
 *   base_i = floor(num_i / subtotal)
 *   rem_i  = num_i mod subtotal
 *   leftover = orderFee - sum(base_i)
 * The `leftover` cents are handed out one each to the lines with the largest rem_i;
 * ties are broken by line `position` ascending (AGENTS.md money rule 4).
 *
 * Guarantee: the returned per-line fees sum EXACTLY to `orderFeeCents`. This is the
 * defence against RED_TEAM AI-02 (per-line rounding drift): we never round each line
 * independently, so the pennies always reconcile to the order fee.
 *
 * Returns fees in the SAME order as the input `lines` (index-aligned).
 */
export function allocateFee(lines: AllocationLine[], orderFeeCents: number): number[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    // An order always has at least one line; an empty allocation is a programming error.
    throw new Error("allocateFee requires at least one line");
  }
  assertSafeNonNegativeInt(orderFeeCents, "orderFeeCents");

  let subtotal = 0;
  for (const line of lines) {
    assertSafePositiveInt(line.total, "line.total");
    assertSafeNonNegativeInt(line.position, "line.position");
    subtotal += line.total;
  }

  // Compute integer base shares and remainders.
  const base: number[] = new Array(lines.length);
  let baseSum = 0;
  const order = lines.map((line, index) => {
    const num = orderFeeCents * line.total;
    const b = Math.floor(num / subtotal);
    base[index] = b;
    baseSum += b;
    return { index, rem: num % subtotal, position: line.position };
  });

  const leftover = orderFeeCents - baseSum;

  // Distribute leftover cents to the largest remainders; ties -> lower position first.
  order.sort((a, b) => {
    if (b.rem !== a.rem) return b.rem - a.rem; // largest remainder first
    return a.position - b.position; // tie: lower position wins
  });

  const fees = base.slice();
  for (let i = 0; i < leftover; i++) {
    const winner = order[i];
    if (winner === undefined) break; // leftover can never exceed line count, but stay safe
    fees[winner.index] = (fees[winner.index] ?? 0) + 1;
  }

  return fees;
}
