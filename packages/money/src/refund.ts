import { MoneyError } from "./errors";
import type { OrderSplit } from "./split";
import { assertSafeNonNegativeInt, assertSafePositiveInt } from "./validate";

/** The amounts that drive a whole-order REFUND journal (integer cents). */
export interface RefundAmounts {
  /** Cash returned to the patient: 100% of the subtotal they paid (FR-8 AC2). */
  patientAmount: number;
  /** COGS credited back to Cerbo's recovery account. */
  cogsReturned: number;
  /** Total debited from PROVIDER_PAYABLE: margin reversal + retained fee (ADR-012). */
  providerDebit: number;
  /** The platform fee Cerbo keeps on the refund (fee_retention, ADR-012). */
  feeRetained: number;
}

/**
 * Compute the amounts for a whole-order refund (FR-8 AC2/AC3, ADR-012, ADR-014).
 *
 *   patientAmount = subtotal     (patient receives 100% of what they paid)
 *   cogsReturned  = cogs
 *   feeRetained   = fee          (Cerbo keeps the platform fee)
 *   providerDebit = margin + fee (provider gives back their margin AND eats the fee)
 *
 * PLATFORM_FEE_REVENUE is intentionally untouched by a refund: the fee was already
 * recognised at payment and is retained, so the provider - not Cerbo - absorbs it.
 * Whole-order refunds only (ADR-014); this takes the order-level split totals.
 */
export function refund(orderSplit: Pick<OrderSplit, "subtotal" | "cogs" | "fee" | "margin">): RefundAmounts {
  // Defensive validation: the split that produced these must itself be integer cents.
  assertSafePositiveInt(orderSplit.subtotal, "orderSplit.subtotal");
  assertSafePositiveInt(orderSplit.cogs, "orderSplit.cogs");
  assertSafeNonNegativeInt(orderSplit.fee, "orderSplit.fee");
  assertSafeNonNegativeInt(orderSplit.margin, "orderSplit.margin");

  // The split identity must hold, or the inputs are not a coherent order split.
  if (orderSplit.subtotal !== orderSplit.cogs + orderSplit.fee + orderSplit.margin) {
    throw new MoneyError(
      "INVALID_INPUT",
      "orderSplit does not satisfy subtotal = cogs + fee + margin",
      { ...orderSplit },
    );
  }

  return {
    patientAmount: orderSplit.subtotal,
    cogsReturned: orderSplit.cogs,
    providerDebit: orderSplit.margin + orderSplit.fee,
    feeRetained: orderSplit.fee,
  };
}
