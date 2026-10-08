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
The provider prices each line with a per-unit dollar markup (ADR-028). The patient pays COGS + markup + the 0.75% fee (built into the unit price; no fee line is shown to the patient).
- AC1: Each line requires `markupCents`, integer cents from 0 to 100000 ($0 to $1,000). The server prices the whole order once (`priceOrder`): `need = sum(qty x (unit_cogs + markup))`, `subtotal = ceil(need x 10000 / (10000 - fee_bps))`, fee = `ceil(subtotal x fee_bps / 10000)`; the subtotal is split across lines by largest remainder of each line's exact share. It stores the line totals, line fees and `unit_markup_cents`. `unitPriceCents` and `marginBps` are rejected with 400 `INVALID_INPUT`
- AC2: The UI shows a live, server-computed quote while the provider types the markup ("Patient pays $X per unit"; `GET /api/products/:sku/price-preview`). Per line the builder shows price, COGS and net margin; the order fee is shown once in the Order summary (line fees are stored and shown in the audit, not on the builder). Because the subtotal and the fee are both rounded up, subtotal - need = fee exactly: no rounding is left over, and every line's net margin is exactly qty x markup
- AC3: The split still guards every line: a line whose net margin after its fee is below 0 is rejected with `MARGIN_NEGATIVE`, naming the line (EVAL-04). A markup-priced line cannot reach it (its margin is exactly qty x markup; a $0 markup nets exactly $0.00); the guard remains for legacy pre-ADR-028 lines, which keep their stored prices and the price-based split()

### FR-3 Stock check at add-to-cart (Tier 1)
- AC1: Adding or increasing a line is allowed only if `available = on_hand - reserved` is >= the requested total quantity for that SKU in this cart
- AC2: Otherwise return `INSUFFICIENT_STOCK` with `available` in details, and the UI shows an alert that stock cannot meet the order and the provider must wait for restock (EVAL-05)
- AC3: Out-of-stock SKUs are visible but marked unavailable

### FR-4 Send to patient (Tier 1 send and snapshot, Tier 2 reservation)
- AC1: Send snapshots unit COGS onto every line, re-derives each line's unit price from its markup against that snapshot COGS (a draft follows the current COGS until then), computes the split via `packages/money`, persists prices and totals, and sets status `sent`
- AC2: Send re-checks stock and reserves the quantity (`reserved += qty`) in the same transaction. Failure returns `INSUFFICIENT_STOCK` and nothing is reserved
- AC3: Reservation expires 7 days after send. Expiry sets status `expired` and releases stock (EVAL-14)
- AC4: Send generates an unguessable patient pay token and calls `Notifier` (stub logs the link). The provider UI shows a copyable patient link
- AC5: Provider can cancel a `draft` or `sent` order. Cancelling a `sent` order releases the reservation

### FR-5 Patient payment, stubbed (Tier 1)
- AC1: The pay page shows patient-safe data only: item names, quantities, unit prices, line totals, order total (EVAL-12). A unit price may be an average (shown as "avg each" when qty x unit price differs from the line total); the line total is what is charged
- AC2: Pay requires an idempotency key. Same key on a paid order returns the original result. A different key on a paid order returns `ALREADY_PAID`. Exactly one payment and one journal exist (EVAL-06)
- AC3: Pay on an `expired` or `cancelled` order returns `ORDER_EXPIRED` or `ORDER_NOT_PAYABLE`
- AC4: In one transaction: lock order, call `PaymentGateway.charge` (stub), insert payment, move reserved stock to sold (`on_hand -= qty`, `reserved -= qty`), post the PAYMENT journal, set status `paid`

### FR-6 Split computed and persisted (Tier 1)
- AC1: Fee = 0.75% of subtotal, rounded UP to the cent, once at order level (ADR-028; EVAL-01, 02, 03)
- AC2: Line fees sum exactly to the order fee. For markup-priced orders, line fee = line total - line cogs - qty x markup (each within 1 cent of the line's exact 0.75%); legacy orders allocate the fee by largest remainder (split())
- AC3: For every order and every line, `cogs + fee + margin = total`
- AC4: The PAYMENT journal posts per-line entries: CASH_CLEARING debit total, COGS_RECOVERY credit cogs, PROVIDER_PAYABLE credit margin, PLATFORM_FEE_REVENUE credit fee. The journal sums to zero

### FR-7 Auditability (Tier 1)
- AC1: `GET /api/orders/:id/audit` returns: order snapshot, lines with every amount, status history, payments, refunds, journals with entries, inventory movements, and an `invariants` block where each check passes or fails explicitly
- AC2: The provider UI has an audit view rendering this for any of their orders. Cerbo Admin can view any order
- AC4 (ADR-028): The audit names every cent of a paid order: subtotal = COGS + platform fee (0.75% rounded up, once per order) + provider markup (sum of qty x markup, as entered); nothing is left over as rounding. Audit lines carry `lineMarkupCents` and the order carries `markupCents` (= marginCents). Line fees are stored (`order_lines.line_fee_cents`) and audited, not shown on the provider order builder. The invariants `order.price_matches_markup` (re-prices the order from the stored snapshot COGS and markups with priceOrder; stored totals and fees must match) and `order.every_cent_accounted` run on every order
- AC3: Ledger tables reject UPDATE and DELETE at the database level, except the synthetic purge path (RT-11)

### FR-8 Refunds (Tier 2)
Whole-order refunds only.
- AC1: Provider (own orders) or Cerbo Admin can refund a `paid` order with a required reason code: `damaged`, `wrong_item`, `patient_request`, `provider_error`, `other`
- AC2: The patient receives 100% of the amount paid
- AC3: The REFUND journal posts per line: CASH_CLEARING credit total, COGS_RECOVERY debit cogs, PROVIDER_PAYABLE debit margin (memo `margin_reversal`), PROVIDER_PAYABLE debit fee (memo `fee_retention`). PLATFORM_FEE_REVENUE is untouched. Journal sums to zero (EVAL-07)
- AC4: If not yet fulfilled, units are restocked (`on_hand += qty`). If fulfilled, no restock and `writeoff_cogs_cents` records Cerbo's COGS loss (EVAL-08)
- AC5: Second refund returns `ALREADY_REFUNDED`. Refund of a non-paid order returns `NOT_REFUNDABLE`
- AC6 (ADR-026, ADR-027): A patient can request a refund on their own paid order only for UNOPENED products (a required confirmation; 400 without it) and only within 30 days of payment (`REFUND_WINDOW_CLOSED` after). One pending request per order
- AC7 (ADR-027): Each request has a review link (`/refund-review/:token`) usable only by the provider who owns the order (404 otherwise). Accept runs the AC1-AC5 refund immediately; Decline requires a note the patient sees. The patient view never contains the token. Return shipping is out of scope

### FR-9 Fulfillment stub (Tier 2)
- AC1: Cerbo Admin can mark a `paid` order fulfilled via `FulfillmentService` (stub). Sets `fulfilled_at`
- AC2: Refunded orders cannot be fulfilled

### FR-10 Provider sales dashboard (Tier 2)
- AC1: Shows, for a date range (default current month, UTC): orders by status, units sold by SKU, GMV, refunded GMV, settled GMV, platform fees, provider net margin
- AC2: Numbers come from ledger entries, not recomputed from order lines
- AC3: Sales count in the month the order was PAID (`orders.paid_at`), refunds in the month of the refund (`refunds.created_at`), so a month's GMV, platform fees and net margin always describe the same orders (METRICS.md basis; same as the admin metrics)
- AC4: Demo orders (`is_synthetic`) are excluded by default; an "Include demo data" switch mixes them in and shows a "Demo data included" banner

### FR-11 Provider payable report (Tier 2)
- AC1: Monthly by default (calendar month UTC), any custom range supported
- AC2: Shows opening balance, credits (margins earned), debits (margin reversals and fee retentions), closing balance, and contributing orders
- AC3: Cerbo Admin can close a month, creating an immutable `payable_statement`. A refund posted after close appears as a debit in the period it was posted; closed statements are never rewritten (EVAL-10)
- AC4: Payout is a stub seam (`PayoutService`), not executed
- AC5: Real orders only: demo data is never included, and the page says so ("Real orders only"), because payables are the money Cerbo actually owes

### FR-12 Recurring orders (Tier 3)
- AC1: Provider creates a schedule for a patient with lines (SKU, qty, markup; `markupCents` required, 0 to 100000) and `interval_days` (default 30, range 7 to 90). One-off remains the default order type
- AC2: Patient authorizes once via their pay link (stubbed saved payment method token). The authorization copy says the per-cycle amount shown is current and can change if product costs change
- AC3: Each cycle creates a child order (`kind = recurring_cycle`) with a fresh COGS snapshot and prices each line from that CURRENT COGS + the schedule's markup (ADR-028), so a cost rise passes through to the patient and the provider keeps the markup (EVAL-11d); it checks stock and margin, charges the saved method, and posts the PAYMENT journal, all in one transaction
- AC4: If stock is short, margin would go negative (possible only for legacy pre-ADR-028 lines without a markup), or the schedule is not authorized, the cycle order is `on_hold` with a reason and the provider sees an alert. Retry is possible after the cause is fixed (EVAL-11)
- AC5: Provider can pause or cancel a schedule
- AC6: Demo: "Run cycle now" action and a `run-due-schedules` job endpoint replace a real scheduler

### FR-13 Cerbo Admin metrics and migration report (Tier 3)
- AC1: Under the "Cerbo Admin" tab, for a date range and grouping (month, provider): total GMV, refunded GMV, settled GMV, platform fee revenue, sunk fees, provider net margin from settled sales, provider net after sunk fees, order count, AOV, recurring share, baseline monthly GMV, migration %, adoption
- AC2: Formulas exactly as `docs/METRICS.md`, including the reconciliation check for provider net margin
- AC3: Toggle "Include synthetic demo data", default OFF (EVAL-13)

### FR-14 Baseline and demo data (Tier 3)
- AC1: Baseline import via CSV upload (`provider_email, order_date, gmv_cents, source`), validated, stored with `import_batch_id`
- AC2: Cerbo Admin can regenerate the synthetic baseline (`seed`, `months`, default 6), replacing only previous synthetic baseline rows
- AC3: Cerbo Admin can generate synthetic in-house migration activity (`seed`, `months`, default 3, ramping share of baseline) that flows through the same split and posting code, flagged `is_synthetic`, backdated via the `Clock` seam (older months on the 15th; the current month on the 15th or two days before today UTC, whichever is earlier, so demo orders never read as today or the future in any timezone), and does not touch inventory
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
- OOS-7 Refund policy enforcement beyond FR-8 AC6 (unopened + 30-day window); return shipping logistics (who pays, labels, receiving, inspection)
- OOS-8 Real job scheduler - demo endpoints instead

## Assumptions
- A-1 Provider and practice are 1:1 in seed data; the model keeps them separate (DECISIONS ADR-010)
- A-2 COGS is Cerbo's unit cost; Cerbo earns no product markup in this slice, only the platform fee
- A-3 Card processing costs are ignored (flagged as a business risk in the final write-up)
- A-4 Recurring "monthly" is modeled as 30 days
