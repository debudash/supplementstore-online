# @cerbo/money

Pure, integer-cents split math for the Cerbo supplement store. **Zero runtime
dependencies.** This package is the single source of truth for all fee,
allocation, margin, pricing, and refund math (AGENTS.md money rule 2): no other
module may recompute these values.

## Rules enforced (see docs/DECISIONS.md)

- **ADR-001** platform fee = 0.75% (75 bps) of the patient-paid subtotal.
- **ADR-003** integer cents everywhere; fee computed once per order, half-up;
  allocated to lines by largest remainder (never per-line rounding).
- **ADR-004** line margin after its allocated fee must be `>= 0`; zero allowed.
- **ADR-005** price is canonical; margin % is an input mode that derives price.
- **ADR-012 / ADR-014** whole-order refund returns 100% to the patient; the
  platform fee is retained and charged to the provider.

## API

```ts
import {
  orderFee,          // (subtotalCents, feeBps=75) -> fee cents, half-up, once per order
  allocateFee,       // (lines, orderFeeCents) -> per-line fees, largest remainder
  split,             // (lines, feeBps=75) -> { subtotal, cogs, fee, margin, lines[] }
  priceFromMarginBps,// (unitCogsCents, marginBps) -> unit price cents
  refund,            // (orderSplit) -> { patientAmount, cogsReturned, providerDebit, feeRetained }
  MoneyError,        // code: "INVALID_INPUT" (400) | "MARGIN_NEGATIVE" (422)
} from "@cerbo/money";
```

All inputs are validated as safe positive integers; violations throw
`MoneyError("INVALID_INPUT")`. A line whose margin after its allocated fee is
negative throws `MoneyError("MARGIN_NEGATIVE")` naming the line position.

## Develop

```
npm install
npm test          # vitest: EVAL example tests + fast-check properties (10k runs)
npm run typecheck
npm run build     # emits dist/ (CommonJS + .d.ts)
```
