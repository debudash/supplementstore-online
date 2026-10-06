# SPEC.md - Requirements and acceptance criteria

Source of truth for scope. Requirement IDs (FR-x) are referenced by tasks, PRs, and evals.
Tier: 1 = must (core flow), 2 = should, 3 = could. Build order follows tiers.

## Functional requirements

### FR-1 Order assembly (Tier 1)
A provider creates a draft order for one of their practice's patients and adds one or more SKUs with quantity.
- AC1: Draft order is created with status `draft`, linked to provider, practice, patient
- AC2: Adding a SKU already in the cart merges into one line (quantity summed)
- AC3: Quantity is an integer from 1 to 100
- AC4: Lines can be edited or removed while the order is `draft`; any edit after `draft` returns `ORDER_NOT_EDITABLE`

### FR-2 Per-item pricing (Tier 1)
The provider sets a patient-facing unit price in cents, OR a margin percent from which the price is derived.
- AC1: Price is the stored canonical value. Margin percent mode computes `price = ceil(unit_cogs * 10000 / (10000 - margin_bps))`, margin_bps from 0 to 9500
- AC2: The UI and the quote endpoint show, per line and per order: price, COGS, allocated fee, and net margin
- AC3: A line whose net margin after its allocated fee is below 0 is rejected with `MARGIN_NEGATIVE`, naming the line (EVAL-04)

### FR-3 Stock check at add-to-cart (Tier 1)
- AC1: Adding or increasing a line is allowed only if `available = on_hand - reserved` is >= the requested total quantity for that SKU in this cart
- AC2: Otherwise return `INSUFFICIENT_STOCK` with `available` in details, and the UI shows an alert that stock cannot meet the order and the provider must wait for restock (EVAL-05)
- AC3: Out-of-stock SKUs are visible but marked unavailable

### FR-4 Send to patient (Tier 1 send and snapshot, Tier 2 reservation)
- AC1: Send snapshots unit COGS onto every line, computes the split via `packages/money`, persists totals, and sets status `sent`
- AC2: Send re-checks stock and reserves the quantity (`reserved += qty`) in the same transaction. Failure returns `INSUFFICIENT_STOCK` and nothing is reserved
- AC3: Reservation expires 7 days after send. Expiry sets status `expired` and releases stock (EVAL-14)
- AC4: Send generates an unguessable patient pay token and calls `Notifier` (stub logs the link). The provider UI shows a copyable patient link
- AC5: Provider can cancel a `draft` or `sent` order. Cancelling a `sent` order releases the reservation

### FR-5 Patient payment, stubbed (Tier 1)
- AC1: The pay page shows patient-safe data only: item names, quantities, unit prices, line totals, order total (EVAL-12)
- AC2: Pay requires an idempotency key. Same key on a paid order returns the original result. A different key on a paid order returns `ALREADY_PAID`. Exactly one payment and one journal exist (EVAL-06)
- AC3: Pay on an `expired` or `cancelled` order returns `ORDER_EXPIRED` or `ORDER_NOT_PAYABLE`
- AC4: In one transaction: lock order, call `PaymentGateway.charge` (stub), insert payment, move reserved stock to sold (`on_hand -= qty`, `reserved -= qty`), post the PAYMENT journal, set status `paid`

### FR-6 Split computed and persisted (Tier 1)
- AC1: Fee = 0.75% of subtotal, half-up, at order level (EVAL-01, 02, 03)
- AC2: Fee is allocated to lines by largest remainder; line fees sum exactly to the order fee
- AC3: For every order and every line, `cogs + fee + margin = total`
- AC4: The PAYMENT journal posts per-line entries: CASH_CLEARING debit total, COGS_RECOVERY credit cogs, PROVIDER_PAYABLE credit margin, PLATFORM_FEE_REVENUE credit fee. The journal sums to zero

### FR-7 Auditability (Tier 1)
- AC1: `GET /api/orders/:id/audit` returns: order snapshot, lines with every amount, status history, payments, refunds, journals with entries, inventory movements, and an `invariants` block where each check passes or fails explicitly
- AC2: The provider UI has an audit view rendering this for any of their orders. Cerbo Admin can view any order
- AC3: Ledger tables reject UPDATE and DELETE at the database level, except the synthetic purge path (RT-11)

### FR-8 Refunds (Tier 2)
Whole-order refunds only.
- AC1: Provider (own orders) or Cerbo Admin can refund a `paid` order with a required reason code: `damaged`, `wrong_item`, `patient_request`, `provider_error`, `other`
- AC2: The patient receives 100% of the amount paid
- AC3: The REFUND journal posts per line: CASH_CLEARING credit total, COGS_RECOVERY debit cogs, PROVIDER_PAYABLE debit margin (memo `margin_reversal`), PROVIDER_PAYABLE debit fee (memo `fee_retention`). PLATFORM_FEE_REVENUE is untouched. Journal sums to zero (EVAL-07)
- AC4: If not yet fulfilled, units are restocked (`on_hand += qty`). If fulfilled, no restock and `writeoff_cogs_cents` records Cerbo's COGS loss (EVAL-08)
- AC5: Second refund returns `ALREADY_REFUNDED`. Refund of a non-paid order returns `NOT_REFUNDABLE`

### FR-9 Fulfillment stub (Tier 2)
- AC1: Cerbo Admin can mark a `paid` order fulfilled via `FulfillmentService` (stub). Sets `fulfilled_at`
- AC2: Refunded orders cannot be fulfilled

### FR-10 Provider sales dashboard (Tier 2)
- AC1: Shows, for a date range (default current month, UTC): orders by status, units sold by SKU, GMV, refunded GMV, settled GMV, platform fees, provider net margin
- AC2: Numbers come from ledger entries, not recomputed from order lines

### FR-11 Provider payable report (Tier 2)
- AC1: Monthly by default (calendar month UTC), any custom range supported
- AC2: Shows opening balance, credits (margins earned), debits (margin reversals and fee retentions), closing balance, and contributing orders
- AC3: Cerbo Admin can close a month, creating an immutable `payable_statement`. A refund posted after close appears as a debit in the period it was posted; closed statements are never rewritten (EVAL-10)
- AC4: Payout is a stub seam (`PayoutService`), not executed

### FR-12 Recurring orders (Tier 3)
- AC1: Provider creates a schedule for a patient with lines (SKU, qty, price) and `interval_days` (default 30, range 7 to 90). One-off remains the default order type
- AC2: Patient authorizes once via their pay link (stubbed saved payment method token)
- AC3: Each cycle creates a child order (`kind = recurring_cycle`) with fresh COGS snapshot and the schedule's locked prices, checks stock and margin, charges the saved method, and posts the PAYMENT journal, all in one transaction
- AC4: If stock is short, margin would go negative, or the schedule is not authorized, the cycle order is `on_hold` with a reason and the provider sees an alert. Retry is possible after the cause is fixed (EVAL-11)
- AC5: Provider can pause or cancel a schedule
- AC6: Demo: "Run cycle now" action and a `run-due-schedules` job endpoint replace a real scheduler

### FR-13 Cerbo Admin metrics and migration report (Tier 3)
- AC1: Under the "Cerbo Admin" tab, for a date range and grouping (month, provider): total GMV, refunded GMV, settled GMV, platform fee revenue, sunk fees, provider net margin from settled sales, provider net after sunk fees, order count, AOV, recurring share, baseline monthly GMV, migration %, adoption
- AC2: Formulas exactly as `docs/METRICS.md`, including the reconciliation check for provider net margin
- AC3: Toggle "Include synthetic demo data", default OFF (EVAL-13)

### FR-14 Baseline and demo data (Tier 3)
- AC1: Baseline import via CSV upload (`provider_email, order_date, gmv_cents, source`), validated, stored with `import_batch_id`
- AC2: Cerbo Admin can regenerate the synthetic baseline (`seed`, `months`, default 6), replacing only previous synthetic baseline rows
- AC3: Cerbo Admin can generate synthetic in-house migration activity (`seed`, `months`, default 3, ramping share of baseline) that flows through the same split and posting code, flagged `is_synthetic`, backdated via the `Clock` seam, and does not touch inventory
- AC4: Cerbo Admin can reset demo data, which purges only `is_synthetic = true` rows (RT-11)
- AC5: All demo endpoints return `DEMO_DISABLED` unless `DEMO_MODE=true`

### FR-15 Restock, demo only (Tier 3)
- AC1: Cerbo Admin can increase `on_hand` for a SKU. Recorded as an inventory movement with actor. UI labels it "Demo only"
- AC2: Providers cannot restock (403)

### FR-16 Stub auth and role switcher (Tier 1)
- AC1: Top bar role switcher lists seeded users: 2 providers (different practices), 2 patients, 1 Cerbo Admin
- AC2: Each role sees only its tabs. API enforces roles and ownership on every route

### FR-17 Deploy (Tier 1)
- AC1: App runs on Railway from the repo Dockerfile with Railway Postgres, migrations run on start, seed runs if the database is empty
- AC2: `GET /api/health` returns 200 with database connectivity status

## Non-functional requirements
- NFR-1 Integrity: money invariants hold for every order, line, and journal, enforced in code, tests, and database constraints
- NFR-2 Idempotency and concurrency: no double charge, no double refund, no oversell under parallel requests (RT-04, RT-05)
- NFR-3 Measurability: every headline metric is derivable from ledger and baseline tables with a synthetic filter
- NFR-4 Seams: every stub sits behind an interface that a real integration could replace without touching business logic
- NFR-5 Privacy of patient view: patient routes never expose COGS, margin, fee, or other patients' data
- NFR-6 All timestamps UTC; all periods are UTC calendar boundaries

## Out of scope
- OOS-1 Real payments, auth, shipping, fulfillment, payouts, email
- OOS-2 Catalog browsing, search, imagery, styling (seeded catalog of 5 SKUs)
- OOS-3 Regulatory, compliance, tax, shipping cost
- OOS-4 Multi-currency, international
- OOS-5 Warehouses, multi-location stock
- OOS-6 Partial (line-level) refunds - ledger supports them later
- OOS-7 Refund policy enforcement (only reason codes are recorded)
- OOS-8 Real job scheduler - demo endpoints instead

## Assumptions
- A-1 Provider and practice are 1:1 in seed data; the model keeps them separate (DECISIONS ADR-010)
- A-2 COGS is Cerbo's unit cost; Cerbo earns no product markup in this slice, only the platform fee
- A-3 Card processing costs are ignored (flagged as a business risk in the final write-up)
- A-4 Recurring "monthly" is modeled as 30 days
