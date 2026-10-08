# @cerbo/money

Pure, integer-cents split math for the Cerbo supplement store. **Zero runtime
dependencies.** This package is the single source of truth for all fee,
allocation, margin, pricing, and refund math (AGENTS.md money rule 2): no other
module may recompute these values.

## Rules enforced (see docs/DECISIONS.md)

- **ADR-001** platform fee = 0.75% (75 bps) of the patient-paid subtotal.
- **ADR-003** integer cents everywhere; fee computed once per order, rounded up
  (amended by ADR-028); amounts handed to lines by largest remainder (never per-line
  rounding).
- **ADR-004** line margin after its fee must be `>= 0`; zero allowed.
- **ADR-028** providers enter a per-unit dollar markup; `priceOrder` rounds the whole
  order ONCE: `need = sum(qty x (unitCogs + markup))`,
  `subtotal = ceil(need * 10000 / (10000 - feeBps))`, `fee = orderFee(subtotal)` (rounded
  up). Both are rounded up, so `subtotal - need = fee` exactly: no rounding is left over
  and every line's margin is exactly `qty x markup` (a $0 markup nets exactly 0). Line
  totals split the subtotal by largest remainder; line fee = total - cogs - qty x markup.
  (Supersedes ADR-005, margin %.) Orders with lines priced before ADR-028 keep the
  price-based `split()`.
- **ADR-012 / ADR-014** whole-order refund returns 100% to the patient; the
  platform fee is retained and charged to the provider.

## API

```ts
import {
  orderFee,          // (subtotalCents, feeBps=75) -> fee cents, rounded up, once per order
  DEFAULT_FEE_BPS,   // 75 (0.75%)
  allocateFee,       // (lines, orderFeeCents) -> per-line fees, largest remainder
  split,             // (lines, feeBps=75) -> { subtotal, cogs, fee, margin, lines[] } (price-based, legacy)
  priceOrder,        // (markup lines, feeBps=75) -> { subtotal, cogs, fee, margin, lines[] } (ADR-028)
  MAX_MARKUP_CENTS,  // 100000 ($1,000)
  refund,            // (orderSplit) -> { patientAmount, cogsReturned, providerDebit, feeRetained }
  processingCostCents, // (amountCents, rateBps=290, fixedCents=30) -> estimated card cost (Evidence page)
  breakevenFeeBps,   // (orderCents, rateBps=290, fixedCents=30) -> smallest fee bps covering it, rounded up
  averageCents,      // (totalCents, count) -> floor average, 0 when count is 0
  DEFAULT_PROCESSING_RATE_BPS, DEFAULT_PROCESSING_FIXED_CENTS, // 290 (2.9%), 30
  MoneyError,        // code: "INVALID_INPUT" (400) | "MARGIN_NEGATIVE" (422)
} from "@cerbo/money";
```

All inputs are validated as safe integers in range (quantities and COGS positive; a markup
may be 0 to `MAX_MARKUP_CENTS`); violations throw `MoneyError("INVALID_INPUT")`. A line whose margin after its allocated fee is
negative throws `MoneyError("MARGIN_NEGATIVE")` naming the line position.

## Develop

```
npm install
npm test          # vitest: EVAL example tests + fast-check properties (10k runs)
npm run typecheck
npm run build     # emits dist/ (CommonJS + .d.ts)
```
