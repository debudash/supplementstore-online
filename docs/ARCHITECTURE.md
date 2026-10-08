# ARCHITECTURE.md

## 1. Topology
One deployable service plus Postgres.

```
Browser (Vue SPA)
   |  REST /api/*  (X-Demo-User header, or /pay/:token for patients)
   v
Express API (Node 20, TS) ----> Postgres 16
   |-- packages/money       pure money math (markup pricing, fee, allocation, legacy split, refunds)
   |-- seams/                PaymentGateway, FulfillmentService, Notifier, PayoutService, Clock (stubs)
   |-- jobs/                 reservation expiry sweep, recurring run-due sweep (on demand; no interval timer)
   '-- serves apps/web/dist  in production (single Railway service)
```

## 2. Repository layout
```
AGENTS.md  CLAUDE.md  README.md  Dockerfile  docker-compose.yml  package.json
.github/workflows/ci.yml  .gitlab-ci.yml (CI + deploy-railway)  railway.json
docs/                       context pack (this folder)
packages/money/             src/{fee,allocate,split,priceOrder,refund,pricing,economics,validate,errors}.ts  test/**
packages/contracts/         src/<module>.ts  (one file per module, owned by that module's task)
apps/api/
  src/app.ts                route mounts (T0, pre-registered)
  src/server.ts             boot: migrate, seed-if-empty, serve SPA, listen
  src/db/                   knex.ts, types.ts (int8 parser), migrations/, seeds/
  src/auth/                 demo-user middleware, role and ownership guards
  src/seams/                interfaces + stubs + index.ts (container)
  src/orders/               draft, lines, quote, send, cancel, delete draft, list; pricing.ts (priceOrder vs legacy split)
  src/patients/             provider's own-practice patient roster
  src/payments/             pay endpoint, posting, patient-safe serializer
  src/patient-orders/       patient "My Orders" listing + refund-request create
  src/refund-requests/      patient refund requests, provider approve/decline, review link (ADR-027)
  src/ledger/               journal writer, account constants, audit query + invariants
  src/refunds/              refund service + REFUND journal posting
  src/fulfillment/          fulfill service
  src/inventory/            products list, price preview, availability, reserve, release
  src/recurring/            schedules, cycles
  src/reports/              provider sales, payables, statements
  src/admin/                inventory/, metrics/, payables/, operations/, demo/, evidence/
  src/jobs/                 expire.ts (reservation expiry), recurring.ts (run-due sweep)
  test/                     api tests, test/invariants/** (protected)
apps/web/
  src/router.ts             all routes pre-registered (T0)
  src/api/                  client
  src/views/provider/       OrderBuilder, Orders, OrderAudit, Recurring, Dashboard, Payables, RefundReview
  src/views/patient/        MyOrders, Pay, ScheduleAuthorize
  src/views/admin/          Evidence, Metrics, Inventory, Operations, DemoData, Payables
tests/e2e/                  scenario evals, golden/** (protected)
```

## 3. Data model (Postgres)
All money columns are integer cents. Per-row amounts use `integer`; aggregates in queries use `bigint`. All timestamps are `timestamptz` UTC.

```
practices        id uuid pk, name text
providers        id uuid pk, practice_id fk, name, email unique
patients         id uuid pk, practice_id fk, name, email, ship_to text
users            id text pk, role check (provider|patient|cerbo_admin), provider_id null fk, patient_id null fk, display_name

products         sku text pk, name, unit_cogs_cents int > 0,
                 list_price_cents int null check (> 0) (unused since ADR-028; kept for history),
                 on_hand_qty int >= 0, reserved_qty int >= 0, check (reserved_qty <= on_hand_qty),
                 active bool, updated_at
product_price_changes  id bigserial, sku fk, old_price_cents, new_price_cents, reason, actor_user_id, changed_at;
                 append-only list-price history (ADR-025); kept, no longer written since ADR-028
inventory_movements  id bigserial, sku fk, delta_on_hand int, delta_reserved int,
                 reason check (seed|restock|reserve|release|sale|refund_restock|adjustment),
                 order_id null fk, actor_user_id, created_at

orders           id uuid pk, provider_id fk, practice_id fk, patient_id fk,
                 kind check (one_off|recurring_cycle), schedule_id null fk, cycle_number int null,
                 status check (draft|sent|paid|cancelled|expired|refunded|on_hold),
                 hold_reason text null,
                 fee_bps int not null default 75,
                 subtotal_cents, cogs_cents, fee_cents, margin_cents  int null (set at send / cycle),
                 check (subtotal_cents is null or subtotal_cents = cogs_cents + fee_cents + margin_cents),
                 check (margin_cents is null or margin_cents >= 0),
                 pay_token text unique null, reservation_expires_at null,
                 sent_at, paid_at, fulfilled_at, cancelled_at, expired_at, refunded_at  null,
                 is_synthetic bool default false, created_at, updated_at
order_lines      id uuid pk, order_id fk, position int, sku fk, qty int check (1..100),
                 unit_price_cents int > 0, unit_cogs_cents int > 0,   -- unit price is display (may be an average, ADR-028)
                 unit_markup_cents int null check (null or 0..100000),  -- ADR-028; null = priced before it
                 line_total_cents int null, line_cogs_cents int null, -- set at send; line_total_cents is authoritative (what is charged)
                 line_fee_cents int null, line_margin_cents int null,  -- line fee stored; used by refunds and the audit
                 unique (order_id, sku), unique (order_id, position),
                 check (line_fee_cents is null or line_total_cents = line_cogs_cents + line_fee_cents + line_margin_cents)
order_events     id bigserial, order_id fk, from_status, to_status, actor_user_id, at, note

payments         id uuid pk, order_id unique fk, idempotency_key text unique, gateway_ref,
                 amount_cents int, created_at, is_synthetic
refunds          id uuid pk, order_id unique fk, reason_code check (damaged|wrong_item|patient_request|provider_error|other),
                 amount_cents, fee_retained_cents, restocked bool, writeoff_cogs_cents int,
                 gateway_ref, actor_user_id, created_at, is_synthetic
refund_requests  id uuid pk, order_id fk (on delete cascade), patient_id fk,
                 reason_code check (damaged|wrong_item|patient_request|other), note text null (<= 500),
                 status check (pending|approved|declined) default pending, decision_note null (<= 500),
                 decided_by null, decided_at null, created_at,
                 unopened_confirmed bool default false, review_token text unique (ADR-027),
                 unique (order_id) where status = 'pending'   -- at most one open request per order
journals         id uuid pk, order_id fk, type check (PAYMENT|REFUND), ref_id uuid, posted_at, is_synthetic
ledger_entries   id bigserial, journal_id fk, order_id fk, line_id null fk,
                 account check (CASH_CLEARING|COGS_RECOVERY|PROVIDER_PAYABLE|PLATFORM_FEE_REVENUE),
                 provider_id null, practice_id null, amount_cents int (signed, debit positive),
                 memo text null, created_at, is_synthetic

recurring_schedules  id uuid pk, provider_id, practice_id, patient_id, interval_days int check (7..90) default 30,
                 next_run_at, status check (active|paused|cancelled),
                 authorized_at null, payment_method_token null, pay_token text unique, created_at
schedule_lines   id uuid pk, schedule_id fk, position, sku fk, qty int check (1..100),
                 unit_markup_cents int not null check (0..100000),
                 unit_price_cents int > 0 (indicative: COGS + markup + fee when created; each cycle re-derives)

payable_statements  id uuid pk, provider_id, practice_id, period_start date, period_end date,
                 opening_cents bigint, credits_cents bigint, debits_cents bigint, closing_cents bigint,
                 closed_at, closed_by, unique (provider_id, period_start)
baseline_imports id uuid pk, source check (csv|synthetic), seed int null, months int null, row_count int, created_at
baseline_orders  id uuid pk, import_batch_id fk, provider_id, practice_id, source_marketplace text,
                 order_date date, gmv_cents int > 0, is_synthetic bool
```

### Database-level protections
- Trigger on `journals`, `ledger_entries`, `payments`, `refunds`, `payable_statements`: raise on UPDATE; raise on DELETE unless the row `is_synthetic` and session setting `app.allow_synthetic_purge = 'on'` (statements are never deletable)
- Trigger on `product_price_changes`: raise on UPDATE and on every DELETE (append-only history)
- Deferred constraint trigger on `ledger_entries`: at commit, each `journal_id` sums to 0
- Row lock on `orders` and `products` for every state change that touches stock or money

## 4. Money algorithm (`packages/money`)
Pure functions, integer only, exhaustively property-tested.

```
orderFee(subtotal, feeBps=75) = ceil(subtotal * feeBps / 10000)       // rounded UP, once per order (ADR-028)
                              = floor((subtotal * feeBps + 9999) / 10000)

allocateFee(lines, orderFee):
  for each line i: num_i = orderFee * total_i
                   base_i = floor(num_i / subtotal), rem_i = num_i mod subtotal
  leftover = orderFee - sum(base_i)
  give +1 to the `leftover` lines with largest rem_i, ties by position ascending

split(lines) -> per line { total, cogs, fee, margin = total - cogs - fee }, order totals
  error MARGIN_NEGATIVE if any line margin < 0 (reports position)

  // split() prices legacy orders (any line priced before ADR-028, no markup) from stored prices.
  // apps/api/src/orders/pricing.ts priceLines() picks: priceOrder when every line has a markup, else split()
  // (drafts, send, recurring cycles); standaloneUnitPrice() gives a draft line's display price on its own.

priceOrder(lines[{position, qty, unitCogs, markupCents}], feeBps)   // ADR-028, 0 <= markupCents <= 100000
  need     = sum(qty x (unitCogs + markupCents))
  subtotal = ceil(need * 10000 / (10000 - feeBps))                    // patient total, rounded ONCE
  fee      = orderFee(subtotal)                                        // rounded up, once
  // both rounded up, so subtotal - need = fee exactly: no rounding is left over
  line totals: subtotal split by largest remainder of each line's exact share (ties by position)
  line fee   = line total - line cogs - qty x markup   // within 1 cent of the line's exact 0.75%; sums to fee
  line margin = qty x markup exactly ($0 markup nets exactly 0)
  unitPriceCents = line total / qty half-up (display); unitPriceIsAverage when total % qty != 0

refund(orderSplit) -> { patientAmount = subtotal, cogsReturned = cogs,
                        providerDebit = margin + fee, feeRetained = fee }
```

Worked example (EVAL-01, priceOrder): MAG-GLY-120 x2 (cogs 1450, markup 1526) and VITD3-K2 x1 (cogs 1125, markup 1356). need = 2 x 2976 + 2481 = 8433; subtotal = ceil(8433 x 10000 / 9925) = 8497; fee = ceil(63.7275) = 64 = 8497 - 8433. Line totals 5997 and 2500 (MAG shows $29.99 avg), line fees 45 and 19, margins 3052 and 1356 (exactly the markups), order margin 4408. (split() on prices 2 x 2999 + 2499 still gives 8497 / 64 / [45, 19] / [3053, 1355].)

## 5. Ledger posting
Sign convention: debit positive, credit negative. Posted per line (`line_id` set) so every cent maps to a SKU.

| Event | CASH_CLEARING | COGS_RECOVERY | PROVIDER_PAYABLE | PLATFORM_FEE_REVENUE |
|---|---|---|---|---|
| PAYMENT | +total | -cogs | -margin | -fee |
| REFUND | -total | +cogs | +margin (`margin_reversal`), +fee (`fee_retention`) | none |

Provider balance owed = `-(sum of PROVIDER_PAYABLE)` for that provider.
A refund leaves the provider at `-fee` for that order and Cerbo keeps the fee.

## 6. State machines
Order (one_off): `draft -> sent -> paid -> refunded`; `draft|sent -> cancelled`; `sent -> expired`. A draft may also be deleted outright (`DELETE /api/orders/:id`; it holds no stock).
Order (recurring_cycle): created `paid` if checks pass and charge succeeds, else `on_hold`; `on_hold -> paid` (retry) or `cancelled`.
`fulfilled_at` is a flag on `paid` orders only. Every transition writes an `order_events` row.

Inventory per SKU: `available = on_hand - reserved`.
| Action | on_hand | reserved |
|---|---|---|
| send (reserve) | 0 | +qty |
| cancel or expire (release) | 0 | -qty |
| pay (sale) | -qty | -qty |
| recurring cycle paid (sale) | -qty | 0 |
| refund before fulfillment | +qty | 0 |
| restock (demo) | +qty | 0 |
Synthetic orders never touch inventory.

## 7. Seams
| Interface | Stub behavior | Real replacement |
|---|---|---|
| `PaymentGateway.charge(amount, idemKey, method?)` / `.refund(ref, amount)` | Returns `stub_ch_<uuid>`; `amount = 1313` cents forces a decline for demo | Stripe-style PaymentIntent with webhook calling the same `recordPaymentSucceeded()` |
| `FulfillmentService.markFulfilled(orderId)` | Logs and returns `stub_ship_<uuid>`; the fulfillment service then sets `fulfilled_at` | 3PL or shipping API |
| `Notifier.sendPayLink(patient, url)` / `.sendRefundNotice(patient, { refundedAmountCents, keepOrDispose })` | Logs, UI shows copyable link; refund notice sent after commit, best effort (ADR-023) | Email or SMS |
| `PayoutService.payout(statement)` | Not called in slice | ACH or connected-account payouts |
| `Clock.now()` | System time; demo generator injects past dates | n/a |

Production note: the stub charges synchronously inside the transaction. A real gateway would create the intent outside the transaction and post on webhook confirmation through the same idempotent posting function.

## 8. REST API (summary)
The full, code-verified contract is `docs/openapi.yaml`.

Provider (`role = provider`, own practice data only):
```
GET    /api/products                       sku, name, unit_cogs_cents, available, active
GET    /api/patients
POST   /api/orders                         { patientId } -> draft
GET    /api/products/:sku/price-preview?markupCents=&qty=   server-computed unit price + line split
POST   /api/orders/:id/lines               { sku, qty, markupCents }   (unitPriceCents / marginBps -> 400)
PATCH  /api/orders/:id/lines/:lineId       { qty?, markupCents? }
DELETE /api/orders/:id/lines/:lineId
DELETE /api/orders/:id                     delete a draft (204)
GET    /api/orders/:id/quote               live split preview
POST   /api/orders/:id/send
POST   /api/orders/:id/cancel
POST   /api/orders/:id/refund              { reasonCode }
GET    /api/orders?status=&from=&to=
GET    /api/orders/:id/audit
GET    /api/orders/:id/refund-request | POST /api/orders/:id/refund-request/approve { note? } | POST .../decline { note }
GET    /api/refund-review/:token | POST /api/refund-review/:token/accept { note? } | POST .../decline { note }   (ADR-027)
POST   /api/schedules { patientId, intervalDays, lines: [{ sku, qty, markupCents }] } | GET /api/schedules | POST /api/schedules/:id/(pause|resume|cancel|run)
GET    /api/reports/sales?from=&to=&includeSynthetic=      sales by orders.paid_at, refunds by refunds.created_at
GET    /api/reports/payables?from=&to=&includeSynthetic=   PROVIDER_PAYABLE by journals.posted_at
```
Patient (role-guarded listing, X-Demo-User, own orders only):
```
GET    /api/patient/orders
POST   /api/patient/orders/:id/refund-request   { reasonCode, unopened: true, note? }   (paid, within 30 days)
```
Patient (token routes, no X-Demo-User):
```
GET    /api/pay/:token                     patient-safe view (whitelisted fields)
POST   /api/pay/:token                     { idempotencyKey }
GET    /api/pay/:token/practice            practice + provider names
GET    /api/pay/schedule/:token | GET /api/pay/schedule/:token/practice | POST /api/pay/schedule/:token/authorize
```
Cerbo Admin:
```
GET    /api/admin/inventory | POST /api/admin/inventory/:sku/restock { qty }      (demo only)
POST   /api/admin/orders/:id/fulfill | POST /api/admin/orders/:id/refund { reasonCode }
GET    /api/admin/orders/:id/audit
GET    /api/admin/metrics?from=&to=&groupBy=none|month|provider&providerId=&includeSynthetic=false
GET    /api/admin/providers
GET    /api/admin/evidence?includeSynthetic=&processingRateBps=&processingFixedCents=
POST   /api/admin/payables/close { month }   GET /api/admin/payables?month=   (real ledger rows only)
POST   /api/admin/baseline/import { csv }
POST   /api/admin/demo/baseline/regenerate { seed, months }
POST   /api/admin/demo/migration/generate  { seed, months }
POST   /api/admin/demo/reset-story
POST   /api/admin/demo/reset
POST   /api/admin/jobs/expire-reservations | POST /api/admin/jobs/run-due-schedules (501, not wired)
GET    /api/health
```

## 9. Error codes
| Code | HTTP |
|---|---|
| INVALID_INPUT | 400 |
| UNAUTHENTICATED (no/unknown X-Demo-User) | 401 |
| FORBIDDEN (wrong role) | 403 |
| DEMO_DISABLED | 403 |
| NOT_FOUND (also for resources not owned) | 404 |
| INSUFFICIENT_STOCK | 409 |
| ORDER_NOT_EDITABLE, ORDER_NOT_PAYABLE (also fulfilling a non-paid order), ORDER_EXPIRED | 409 |
| ALREADY_PAID, IDEMPOTENCY_CONFLICT | 409 |
| ALREADY_REFUNDED, NOT_REFUNDABLE | 409 |
| REFUND_REQUEST_EXISTS, REFUND_WINDOW_CLOSED, NO_PENDING_REQUEST (refund requests) | 409 |
| SCHEDULE_NOT_ACTIONABLE (cancelled schedule) | 409 |
| ALREADY_CLOSED, PERIOD_NOT_ENDED (payables close) | 409 |
| DEMO_RESET_BLOCKED | 409 |
| MARGIN_NEGATIVE | 422 |
| PAYMENT_DECLINED | 402 |
| NOT_IMPLEMENTED (`/api/admin/jobs/run-due-schedules`) | 501 |
| INTERNAL | 500 |

## 10. Jobs
There is no in-process interval timer today (`server.ts` only migrates, seeds and listens). Reservation expiry (`jobs/expire.ts`) runs on demand via `POST /api/admin/jobs/expire-reservations`; independently, paying a `sent` order whose reservation has lapsed returns 409 ORDER_EXPIRED even before the sweep runs. Recurring cycles run per schedule via the provider's `POST /api/schedules/:id/run`; the run-due sweep function (`jobs/recurring.ts` `runDueSchedules`) exists but nothing calls it yet (`POST /api/admin/jobs/run-due-schedules` returns 501). Jobs are idempotent and safe to run concurrently (row locks, status guards).

## 11. Frontend
Top bar: role switcher (sets `X-Demo-User`). Tabs by role:
- Provider: New Order, Orders (with Audit), Recurring, Dashboard (with an "Include demo data" switch, off by default, that sends `includeSynthetic=true`), Payables; Refund Review page reached by link
- Patient: My Orders; Pay and recurring-authorize pages reached by link
- Cerbo Admin: Evidence, Metrics, Inventory (Demo only), Operations (fulfill, refund, run jobs), Demo Data, Payables

## 12. Deployment
Single Docker image (multi-stage: build web, build api, runtime serves both). Railway service plus Railway Postgres. On start: `migrate latest`, seed if empty, listen on `PORT`. Details in `docs/DEPLOY.md`.
