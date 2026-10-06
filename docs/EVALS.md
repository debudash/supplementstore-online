# EVALS.md - Golden scenarios and acceptance evals

These scenarios are the acceptance bar. T13 implements them in `tests/e2e/golden/` against a freshly seeded database, through the REST API. Expected values are exact cents. Workers must never change an expected value to make a test pass (see AGENTS.md section 4).

## Seed data (T2 must create exactly this)
| Type | ID | Details |
|---|---|---|
| Practice | Riverside Integrative | |
| Practice | Summit DPC | |
| User/provider | `prov-ana` | Dr. Ana Reyes, Riverside |
| User/provider | `prov-ben` | Dr. Ben Cole, Summit |
| User/patient | `pat-cara` | Cara Lopez, Riverside |
| User/patient | `pat-dev` | Dev Patel, Summit |
| User/admin | `admin-cerbo` | Cerbo Admin |

| SKU | Name | unit_cogs_cents | on_hand |
|---|---|---|---|
| MAG-GLY-120 | Magnesium Glycinate 120ct | 1450 | 50 |
| VITD3-K2 | Vitamin D3 + K2 | 1125 | 40 |
| OMEGA3-1000 | Omega-3 Fish Oil 1000mg | 2280 | 30 |
| PROBIO-50B | Probiotic 50B CFU | 2675 | 5 |
| ZINC-30 | Zinc Picolinate 30mg | 690 | 0 |

## Money core (also unit-tested in packages/money)
| ID | Scenario | Expected |
|---|---|---|
| EVAL-01 | `prov-ana` order for `pat-cara`: MAG-GLY-120 x2 @ 2999, VITD3-K2 x1 @ 2499 | subtotal 8497, cogs 4025, fee 64, line fees [45, 19], line margins [3053, 1355], order margin 4408 |
| EVAL-02 | OMEGA3-1000 x1 @ 4999 | fee 37 (37.4925 rounds down), margin 2682 |
| EVAL-03 | Half-up boundary: VITD3-K2 x1 @ 2200 | fee 17 (exact 16.5 rounds up), margin 1058 |
| EVAL-04 | Margin floor on VITD3-K2 (cogs 1125) | @1125 rejected MARGIN_NEGATIVE (margin -8); @1132 rejected (-1); @1133 accepted with margin 0 |
| EVAL-04b | Margin % mode: MAG-GLY-120 with marginBps 5000 | unit price 2900 |
| EVAL-P1 | Property tests (fast-check, 10k runs): random 1 to 10 lines, qty 1 to 100, prices >= cogs | line fees sum to order fee; each line cogs + fee + margin = total; fee = half-up of subtotal x 0.0075; allocation deterministic |

## Inventory
| ID | Scenario | Expected |
|---|---|---|
| EVAL-05 | `prov-ana` adds PROBIO-50B x6 | 409 INSUFFICIENT_STOCK, details.available = 5. x5 succeeds |
| EVAL-05b | Add ZINC-30 x1 | 409 INSUFFICIENT_STOCK, available 0 |
| EVAL-05c | `prov-ana` sends order with PROBIO-50B x5; `prov-ben` adds PROBIO-50B x1 | `prov-ben` gets 409, available 0. After `prov-ana` cancels, available 5 |
| EVAL-14 | Send an order, advance Clock 7 days + 1 minute, run expire job | status `expired`, reserved released, pay returns ORDER_EXPIRED |

## Payment and ledger
| ID | Scenario | Expected |
|---|---|---|
| EVAL-06 | Pay EVAL-01 order twice with same key, then once with a new key | first two return the same payment id; third returns 409 ALREADY_PAID; exactly 1 payment, 1 PAYMENT journal |
| EVAL-06b | Payment journal for EVAL-01 | entries per line; CASH +8497, COGS -4025, PAYABLE -4408, FEE -64; journal sum 0; MAG on_hand 48, VITD3 on_hand 39, reserved back to 0 |
| EVAL-06c | Audit endpoint for EVAL-01 | all invariant checks `pass`; status history draft -> sent -> paid |
| EVAL-06d | Decline: order totaling 1313 cents (stub decline trigger) | 402 PAYMENT_DECLINED; order stays `sent`; no payment or journal |

## Refunds
| ID | Scenario | Expected |
|---|---|---|
| EVAL-07 | Refund paid EVAL-01 (not fulfilled), reason patient_request | refund amount 8497; REFUND journal CASH -8497, COGS +4025, PAYABLE +4408 (margin_reversal) +64 (fee_retention); FEE unchanged; journal sum 0; MAG on_hand back to 50, VITD3 to 40; fee_retained 64; status refunded |
| EVAL-07b | Refund again | 409 ALREADY_REFUNDED |
| EVAL-08 | Pay EVAL-02, fulfill, refund reason damaged | no restock (OMEGA on_hand stays 29); writeoff_cogs 2280 |
| EVAL-08b | Refund a `sent` order | 409 NOT_REFUNDABLE |

## Reports
| ID | Scenario | Expected |
|---|---|---|
| EVAL-09 | Same month: EVAL-01 paid then refunded, EVAL-02 paid (not refunded). Metrics for that month, synthetic off | Total GMV 13496; Refunded GMV 8497; Settled GMV 4999; Fee revenue 101; Sunk fees 64; Provider net margin from settled 2682; Provider net after sunk fees 2618; reconciliation pass |
| EVAL-09b | Provider payables for `prov-ana`, same month | credits 7090, debits 4472, closing 2618 |
| EVAL-10 | Order paid in month M, month M closed, refund posted in month M+1 | M statement unchanged; M+1 shows debits = margin + fee of that order |

## Recurring
| ID | Scenario | Expected |
|---|---|---|
| EVAL-11 | Schedule MAG-GLY-120 x1 @ 2999, authorized, run cycle | child order kind recurring_cycle, paid, fee 22, margin 1527, MAG on_hand -1 |
| EVAL-11b | Schedule PROBIO-50B x6 | cycle on_hold, hold_reason INSUFFICIENT_STOCK, no journal |
| EVAL-11c | Unauthorized schedule run | on_hold, NOT_AUTHORIZED |
| EVAL-11d | Raise MAG cogs to 3000 (test helper), run cycle | on_hold, MARGIN_NEGATIVE |

## Privacy and demo isolation
| ID | Scenario | Expected |
|---|---|---|
| EVAL-12 | GET /api/pay/:token | response keys are a strict whitelist: items[name, qty, unitPriceCents, lineTotalCents], totalCents, status, patientFirstName. No cogs, fee, margin, provider economics |
| EVAL-13 | Record metrics, generate synthetic baseline and migration, re-query with includeSynthetic=false | identical to before; with true, migration % present. After reset, synthetic row counts are 0 and real rows unchanged |
| EVAL-15 | DEMO_MODE=false, call any /api/admin/demo/* | 403 DEMO_DISABLED |
