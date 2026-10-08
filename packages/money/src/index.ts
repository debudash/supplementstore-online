/**
 * @cerbo/money - the single source of truth for all split math.
 *
 * AGENTS.md money rule 2: no other module computes fees, allocations, margins, or
 * refund amounts. API and UI call these pure, integer-cents functions. Zero runtime
 * dependencies (AGENTS.md scope guardrail).
 */
export { MoneyError } from "./errors";
export type { MoneyErrorCode } from "./errors";

export { assertSafePositiveInt, assertSafeNonNegativeInt, assertSafeIntegerInRange } from "./validate";

export { orderFee, DEFAULT_FEE_BPS } from "./fee";

export { allocateFee } from "./allocate";
export type { AllocationLine } from "./allocate";

export { split } from "./split";
export type { SplitLineInput, SplitLine, OrderSplit } from "./split";

export { MAX_MARKUP_CENTS } from "./pricing";
export { priceOrder } from "./priceOrder";
export type { MarkupLineInput, PricedLine, PricedOrder } from "./priceOrder";

export {
  processingCostCents,
  breakevenFeeBps,
  averageCents,
  DEFAULT_PROCESSING_RATE_BPS,
  DEFAULT_PROCESSING_FIXED_CENTS,
} from "./economics";

export { refund } from "./refund";
export type { RefundAmounts } from "./refund";
