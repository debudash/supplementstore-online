# METRICS.md - Metric definitions

All metrics are computed from ledger entries, refunds, and baseline tables, in integer cents, UTC calendar periods.
Every query takes `includeSynthetic` (default false). Basis: payment events count on `paid_at`, refund events on refund `created_at`.

## Headline: GMV and platform revenue
| Metric | Definition | Source |
|---|---|---|
| Total GMV | Sum of PAYMENT journal CASH_CLEARING debits in period | ledger_entries |
| Refunded GMV | Sum of refunds.amount_cents in period | refunds |
| Settled GMV | Total GMV - Refunded GMV | derived |
| Platform fee revenue | -(sum of PLATFORM_FEE_REVENUE entries) in period. Includes fees on orders later refunded (retained) | ledger_entries |
| Sunk fees on refunded GMV | Sum of refunds.fee_retained_cents in period. Approximately Refunded GMV x 0.0075 (exact cents may differ by rounding) | refunds |
| Order count, AOV | Paid orders in period; Total GMV / order count (integer division, display only) | orders |
| Recurring share | GMV from `recurring_cycle` orders / Total GMV | orders, ledger |

## Provider economics
| Metric | Definition |
|---|---|
| Provider markup (`providerMarkupCents`) | Sum over settled orders (paid in period, not refunded) of qty x unit_markup_cents, for lines with a tracked markup (ADR-028; lines priced before it have no markup and are excluded) |
| Markup units (`markupUnits`) | Units on those same lines |
| Average markup per unit (`avgMarkupPerUnitCents`) | floor(providerMarkupCents / markupUnits); 0 when there are no such units |
| Provider net margin from settled sales | Sum of margin_cents over orders paid in period and not refunded |
| Reconciliation check | Per order: subtotal - cogs - orderFee(subtotal), where orderFee = 0.75% of subtotal, half-up (ADR-001). Summed across orders it must match the ledger figure. Shown as a pass/fail line in the report |
| Provider net after sunk fees | Provider net margin from settled sales - sunk fees |
| Payable balance | -(sum of PROVIDER_PAYABLE entries) up to period end |

Note: the reconciliation is computed per order in integer cents and then summed; applying one blended margin % across orders with different margins produces a wrong number (ADR-015). Because each markup-priced line is rounded up to cover the fee (ADR-028), provider net margin from settled sales is always >= providerMarkupCents (the sum of qty x markup); the difference is the round-up headroom, a few cents per order.

## Leading indicator: migration off third-party marketplaces
| Metric | Definition |
|---|---|
| Baseline monthly GMV (per provider) | Sum of baseline_orders.gmv_cents / number of distinct months covered in that provider's baseline |
| Migration % (per provider, per month) | In-house Total GMV for the month / baseline monthly GMV. Can exceed 100% (growth beyond prior external volume) |
| Migration % (overall, per month) | Sum of in-house GMV for providers with a baseline in the month / sum of their baseline monthly GMV |
| Migration trend (the leading indicator) | Migration % for each calendar month in the selected range, overall and per provider (`byMonth`). A rising trend means in-house volume is replacing marketplace volume |
| Migration % for a multi-month range | Average month: in-house GMV in the range / (baseline monthly GMV x months in the range). A 3-month range is never divided by a single month's baseline |
| Adoption | Providers with at least 1 in-house paid order in period / providers with a baseline |
| No baseline | Providers without baseline rows are listed separately and excluded from migration % |

## Known limitations
- Migration % assumes baseline demand is stable; seasonality is not adjusted
- External purchases made after go-live are not observed; migration is inferred from in-house growth against baseline
- Real baseline source is not defined; CSV import is the interim mechanism
