# METRICS.md - Metric definitions

All metrics are computed from ledger entries, refunds, and baseline tables, in integer cents, UTC calendar periods.
Every query takes `includeSynthetic` (default false; the admin Metrics page and the provider Dashboard have an "Include demo data" switch). Basis: payment events count on `paid_at`, refund events on refund `created_at`. Provider payables are the exception: they are ledger movements by `journals.posted_at` and never include demo data.

## Headline: GMV and platform revenue
| Metric | Definition | Source |
|---|---|---|
| Total GMV | Sum of PAYMENT journal CASH_CLEARING debits for orders PAID in the period (`orders.paid_at`, not `journals.posted_at`) - admin metrics and the provider dashboard use the same basis | ledger_entries |
| Refunded GMV | Sum of refunds.amount_cents in period | refunds |
| Settled GMV | Total GMV - Refunded GMV | derived |
| Platform fee revenue | -(sum of PLATFORM_FEE_REVENUE entries) for orders PAID in the period (`orders.paid_at`). Includes fees on orders later refunded (retained) | ledger_entries |
| Sunk fees on refunded GMV | Sum of refunds.fee_retained_cents in period. Approximately Refunded GMV x 0.0075 (each order's fee is rounded up to the cent, so exact cents may differ) | refunds |
| Order count, AOV | Paid orders in period; Total GMV / order count (integer division, display only) | orders |
| Recurring share | GMV from `recurring_cycle` orders / Total GMV | orders, ledger |

## Provider economics
| Metric | Definition |
|---|---|
| Provider markup (`providerMarkupCents`) | Sum over settled orders (paid in period, not refunded) of qty x unit_markup_cents, for lines with a tracked markup (ADR-028; lines priced before it have no markup and are excluded) |
| Markup units (`markupUnits`) | Units on those same lines |
| Average markup per unit (`avgMarkupPerUnitCents`) | floor(providerMarkupCents / markupUnits); 0 when there are no such units |
| Provider net margin from settled sales | Sum of margin_cents over orders paid in period and not refunded |
| Reconciliation check | Per order: subtotal - cogs - orderFee(subtotal), where orderFee = 0.75% of subtotal rounded UP to the cent, once per order (ADR-001 as amended by ADR-028). For a markup-priced order this equals the ledger margin exactly (= sum of qty x markup). Summed across orders it must match the ledger figure. Shown as a pass/fail line in the report |
| Provider net after sunk fees | Provider net margin from settled sales - sunk fees |
| Payable balance | -(sum of PROVIDER_PAYABLE entries) up to period end |

Note: the reconciliation is computed per order in integer cents and then summed; applying one blended margin % across orders with different margins produces a wrong number (ADR-015). Because the order total and the fee are both rounded up once per order (ADR-028), nothing is left over as rounding: for markup-priced orders, provider net margin from settled sales equals providerMarkupCents (the sum of qty x markup) exactly (EVAL-09: both 2681). Orders with lines priced before ADR-028 have no markup and can differ.

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
