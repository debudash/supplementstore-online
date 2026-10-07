# DIAGRAMS.md - Architecture and sequence diagrams

These diagrams describe the system **as merged on `main`** at the time of writing, not
the aspiration. Where a flow is specified in the context pack but its code is not yet
merged, the diagram says so explicitly and cites the spec section it is drawn from. Every
diagram cites the source file(s) a reader can check it against.

Rendering: all diagrams are Mermaid fenced code blocks, which GitLab renders natively. No
image files, no external tooling, no new dependencies.

See the "Status at time of writing" section at the end for the merged / in-review /
not-built breakdown per task.

---

## 1. System architecture (container level)

One deployable Node service serves both the REST API and the built Vue SPA, backed by a
single Postgres. All external dependencies are reached only through seam interfaces whose
current implementations are in-process stubs (AGENTS.md section 6).

```mermaid
flowchart TB
  browser["Browser - Vue 3 SPA (apps/web)<br/>role switcher sets X-Demo-User;<br/>patient reaches /pay/:token by link"]

  subgraph service["Single Node 20 service (apps/api, Express) - serves API + built SPA"]
    direction TB
    spa["Static SPA<br/>apps/web/dist served at /"]
    api["REST API /api/*<br/>app.ts route registry"]
    money["packages/money<br/>pure split math: fee, allocate,<br/>split, refund, pricing (zero deps)"]
    jobs["jobs/<br/>reservation expiry sweep<br/>(60s interval + admin endpoint)"]
    subgraph seams["seams/ (interfaces + STUBS, wired in seams/index.ts)"]
      direction LR
      pg["PaymentGateway (stub)<br/>stub_ch_uuid; 1313c forces decline"]
      fs["FulfillmentService (stub)<br/>sets fulfilled_at"]
      nt["Notifier (stub)<br/>logs pay link"]
      po["PayoutService (stub)<br/>not called in slice"]
      ck["Clock (stub)<br/>system time; demo injects dates"]
    end
    api --> money
    api --> seams
    jobs --> seams
  end

  pgx["External payment processor<br/>(Stripe-style PaymentIntent + webhook)"]
  fx["3PL / shipping API"]
  nx["Email / SMS provider"]
  px["ACH / connected-account payout"]

  db[("Postgres 16<br/>money = integer cents;<br/>append-only ledger triggers")]

  browser -- "REST over HTTPS<br/>/api/* (X-Demo-User)<br/>/api/pay/:token (token)" --> api
  browser -- "GET /" --> spa
  api --> db
  jobs --> db

  pg -. "real replacement<br/>(NOT built)" .-> pgx
  fs -. "real replacement<br/>(NOT built)" .-> fx
  nt -. "real replacement<br/>(NOT built)" .-> nx
  po -. "real replacement<br/>(NOT built)" .-> px
```

Source: `apps/api/src/app.ts`, `apps/api/src/seams/` (`index.ts`, `paymentGateway.ts`,
`fulfillment.ts`, `notifier.ts`, `payout.ts`, `clock.ts`), `apps/api/src/jobs/expire.ts`,
`apps/web/src/router.ts`. Dashed arrows are the real-service replacements from
`docs/ARCHITECTURE.md` section 7 - none are built; every seam is an in-process stub today.

### Deployment shape (Railway)

Railway cannot source builds from self-hosted GitLab (its native deploy-on-push is
GitHub-only), so GitLab CI pushes the build to Railway with `railway up` instead.

```mermaid
flowchart LR
  dev["Developer<br/>merge to main"] --> gl["GitLab (self-hosted)<br/>labs.gauntletai.com<br/>.gitlab-ci.yml"]

  subgraph ci["GitLab CI pipeline on main"]
    direction TB
    guard["guardrails + build-test stages"]
    deploy["deploy-railway job<br/>rules: branch==main AND RAILWAY_TOKEN set<br/>railway up --service RAILWAY_SERVICE"]
    poll["health gate<br/>poll RAILWAY_HEALTHCHECK_URL<br/>until HTTP 200 (~5 min) or fail"]
    guard --> deploy --> poll
  end

  gl --> ci

  subgraph railway["Railway project pleasing-magic (env production)"]
    direction TB
    appsvc["Service cerbo-api<br/>built from repo Dockerfile<br/>serves API + SPA on PORT"]
    rpg[("Railway Postgres<br/>(service named Postgres)<br/>DATABASE_URL reference")]
    appsvc --> rpg
  end

  deploy -- "uploads repo;<br/>Railway builds Dockerfile" --> appsvc
  poll -- "GET /api/health -> 200" --> appsvc
```

Source: `.gitlab-ci.yml` (`deploy-railway` job), `railway.json`, `Dockerfile`,
`docs/DEPLOY.md`. `railway up` returns at queue time, so the health poll (not the `up`
exit code) is the real deploy gate. The live deploy itself is human gate G5 and is not
performed by workers.

---

## 2. Data model (entity relationship)

The real tables from T2's five migrations (merged, gate G2). Money columns are integer
cents. Append-only tables are marked; DB triggers (migration 5) reject UPDATE on them and
reject DELETE unless a synthetic-purge flag is set (`payable_statements` is never
deletable). A deferred constraint trigger makes each journal's `ledger_entries` sum to
zero at commit.

```mermaid
erDiagram
  PRACTICES ||--o{ PROVIDERS : has
  PRACTICES ||--o{ PATIENTS : has
  PROVIDERS ||--o{ ORDERS : places
  PRACTICES ||--o{ ORDERS : for
  PATIENTS  ||--o{ ORDERS : for
  ORDERS    ||--o{ ORDER_LINES : contains
  ORDERS    ||--o{ ORDER_EVENTS : logs
  PRODUCTS  ||--o{ ORDER_LINES : "priced from"
  PRODUCTS  ||--o{ INVENTORY_MOVEMENTS : moves
  ORDERS    ||--o| PAYMENTS : "paid by (1 to 1)"
  ORDERS    ||--o| REFUNDS : "refunded by (1 to 1)"
  ORDERS    ||--o{ JOURNALS : posts
  JOURNALS  ||--o{ LEDGER_ENTRIES : "balances to 0"
  ORDER_LINES ||--o{ LEDGER_ENTRIES : "per line"
  USERS     }o--o| PROVIDERS : "is (role provider)"
  USERS     }o--o| PATIENTS : "is (role patient)"

  PRACTICES {
    uuid id PK
    text name
  }
  PROVIDERS {
    uuid id PK
    uuid practice_id FK
    text email UK
  }
  PATIENTS {
    uuid id PK
    uuid practice_id FK
    text ship_to
  }
  USERS {
    text id PK
    text role "provider|patient|cerbo_admin"
    uuid provider_id FK
    uuid patient_id FK
  }
  PRODUCTS {
    text sku PK
    int unit_cogs_cents "gt 0"
    int on_hand_qty
    int reserved_qty "lte on_hand"
    bool active
  }
  INVENTORY_MOVEMENTS {
    bigserial id PK
    text sku FK
    int delta_on_hand
    int delta_reserved
    text reason "seed|restock|reserve|release|sale|refund_restock|adjustment"
    uuid order_id FK
  }
  ORDERS {
    uuid id PK
    uuid provider_id FK
    uuid practice_id FK
    uuid patient_id FK
    text kind "one_off|recurring_cycle"
    uuid schedule_id FK
    text status "draft|sent|paid|cancelled|expired|refunded|on_hold"
    int fee_bps "default 75"
    int subtotal_cents "snapshot at send"
    int cogs_cents
    int fee_cents
    int margin_cents "gte 0"
    text pay_token UK
    timestamptz reservation_expires_at
    bool is_synthetic
  }
  ORDER_LINES {
    uuid id PK
    uuid order_id FK
    int position
    text sku FK
    int qty "1..100"
    int unit_price_cents "gt 0"
    int unit_cogs_cents "snapshot"
    int unit_markup_cents "null or 0..100000 (ADR-028)"
    int line_total_cents
    int line_cogs_cents
    int line_fee_cents
    int line_margin_cents
  }
  ORDER_EVENTS {
    bigserial id PK
    uuid order_id FK
    text from_status
    text to_status
    text actor_user_id
  }
  PAYMENTS {
    uuid id PK
    uuid order_id FK "unique, APPEND-ONLY"
    text idempotency_key UK
    text gateway_ref
    int amount_cents
  }
  REFUNDS {
    uuid id PK
    uuid order_id FK "unique, APPEND-ONLY"
    text reason_code "damaged|wrong_item|patient_request|provider_error|other"
    int amount_cents
    int fee_retained_cents
    bool restocked
    int writeoff_cogs_cents
  }
  JOURNALS {
    uuid id PK
    uuid order_id FK
    text type "PAYMENT|REFUND, APPEND-ONLY"
    uuid ref_id
  }
  LEDGER_ENTRIES {
    bigserial id PK
    uuid journal_id FK "APPEND-ONLY, sums to 0"
    uuid order_id FK
    uuid line_id FK
    text account "CASH_CLEARING|COGS_RECOVERY|PROVIDER_PAYABLE|PLATFORM_FEE_REVENUE"
    int amount_cents "signed, debit positive"
  }
```

Append-only and trigger-protected (migration 5): `journals`, `ledger_entries`,
`payments`, `refunds`, `payable_statements`. UPDATE is always rejected; DELETE is rejected
unless the row is `is_synthetic` and the guarded purge flag is on, except
`payable_statements`, which is never deletable.

Tier 2/3 tables exist in the schema but their feature code is not merged:
`recurring_schedules` and `schedule_lines` (recurring, T9), `payable_statements`
(payables close), `baseline_imports` and `baseline_orders` (baseline/migration, admin).
They are omitted from the ER diagram above only for readability; they are real columns in
the migrations.

Source: `apps/api/src/db/migrations/20261005120001_reference_and_catalog.ts`,
`20261005120002_orders_and_inventory.ts`, `20261005120003_ledger.ts`,
`20261005120004_reports_and_baseline.ts`, `20261005120005_protections.ts`.

---

## 3. Sequence - order creation to send (MERGED, T3)

Provider builds a draft, adds lines with a per-unit dollar markup (the server derives the
price as COGS + markup + fee, ADR-028), watches the live server-computed quote, then sends. Send takes a `products`
row lock, snapshots COGS, re-derives each line's price from that COGS + its markup, and
writes the computed split onto the order and lines, reserves stock
with a 7-day expiry, and moves the order to `sent`. All split math is in `packages/money`
and runs server-side; the UI never computes fees, margins, or allocations.

```mermaid
sequenceDiagram
  autonumber
  actor Prov as Provider (SPA)
  participant API as orders/router.ts
  participant Svc as orders/service.ts
  participant Money as packages/money (split, priceFromMarkupCents)
  participant Inv as inventory/service.ts
  participant DB as Postgres
  participant Notif as Notifier (stub)

  Prov->>API: POST /api/orders { patientId }
  API->>Svc: createDraft(actor, body)
  Svc->>DB: verify patient in actor practice (else 404)
  Svc->>DB: insert order (status=draft) + order_events(to draft)
  API-->>Prov: 201 OrderView (status draft)

  Prov->>API: POST /api/orders/:id/lines { sku, qty, markupCents }
  Note over API,Svc: unitPriceCents or marginBps then 400 INVALID_INPUT (retired)
  API->>Svc: addLine(...)
  Svc->>DB: load product (catalog COGS)
  Svc->>Money: priceFromMarkupCents(unitCogs, markupCents, fee_bps)
  Money-->>Svc: unit price = ceil((COGS + max(markup, 1)) / (1 - fee))
  Svc->>DB: merge or insert line (qty sums for same SKU)
  Note over Svc,Inv: add-to-cart stock gate: available = on_hand - reserved
  Svc->>Money: split(lines, fee_bps) re-validate whole cart
  Money-->>Svc: throws MARGIN_NEGATIVE then 422 rollback if any line lt 0
  API-->>Prov: 200 OrderView

  Prov->>API: GET /api/orders/:id/quote
  API->>Svc: getQuote(...)
  Svc->>Money: split(lines, fee_bps) using LIVE catalog COGS (draft)
  Money-->>Svc: totals + per-line fee/margin
  API-->>Prov: 200 live split preview

  Prov->>API: POST /api/orders/:id/send
  API->>Svc: sendOrder(actor, id, seams)
  Svc->>Svc: clock.now(); expiresAt = now + 7 days; pay_token = randomBytes(24).base64url
  rect rgb(235,245,255)
    Note over Svc,DB: ONE transaction with products row lock (FOR UPDATE, ordered by sku)
    Svc->>DB: SELECT products FOR UPDATE (snapshot COGS now, ADR-006)
    Svc->>Money: priceFromMarkupCents(snapshot COGS, markup) per line, then split(inputs, fee_bps)
    Money-->>Svc: per-line total/cogs/fee/margin (or MARGIN_NEGATIVE then rollback)
    Svc->>Inv: reserveLines(...) re-check available, inc reserved_qty, write reserve movement
    Note over Inv,DB: INSUFFICIENT_STOCK then rollback, nothing reserved
    Svc->>DB: UPDATE order_lines (snapshot + split); UPDATE orders status=sent, totals, pay_token, reservation_expires_at
    Svc->>DB: insert order_events(draft to sent)
  end
  Svc->>Notif: sendPayLink(patient, /pay/:token) after commit
  API-->>Prov: 200 { order, payUrl = /pay/:token }
```

Source: `apps/api/src/orders/service.ts` (`createDraft`, `addLine`, `updateLine`,
`getQuote`, `sendOrder`), `apps/api/src/orders/router.ts`,
`apps/api/src/inventory/service.ts` (`reserveLines`, `availableOf`),
`packages/money/src/split.ts`, `packages/money/src/pricing.ts`. Reservation lifetime
`RESERVATION_DAYS = 7` is in `orders/service.ts`.

---

## 4. Sequence - patient payment and ledger posting (SPECIFIED, NOT YET MERGED - T4)

This is the most important flow in the document. **It is not merged.** On `main` today
`apps/api/src/payments/router.ts` is a 501 stub and there is no `apps/api/src/ledger/`
directory; T4 (payment, ledger posting, audit) is under human review at gate G3. The
diagram below is drawn from `docs/ARCHITECTURE.md` sections 5 and 8, AGENTS.md money rules
6-9, and ADR-007/008. When T4 merges, redraw from the real code.

The patient route uses the unguessable `pay_token` in the URL, never `X-Demo-User`. The
status change, ledger posting, and inventory change happen in ONE transaction under a
`SELECT ... FOR UPDATE` row lock on the order. The server recomputes every amount from DB
snapshots and ignores any client-sent price.

```mermaid
sequenceDiagram
  autonumber
  actor Pat as Patient (via pay link)
  participant API as payments/router.ts (SPEC)
  participant Svc as payment posting (SPEC)
  participant DB as Postgres
  participant Gw as PaymentGateway (stub)
  participant Money as packages/money (split)

  Pat->>API: GET /api/pay/:token
  API->>DB: load order by pay_token
  API-->>Pat: 200 whitelist only (items name/qty/unitPrice/lineTotal, totalCents, status, patientFirstName)
  Note over API,Pat: no cogs, fee, margin, or provider economics (EVAL-12)

  Pat->>API: POST /api/pay/:token { idempotencyKey }
  API->>Svc: pay(token, idempotencyKey) ignore any client-sent amount (money rule 9)

  rect rgb(235,245,255)
    Note over Svc,DB: ONE transaction, SELECT order FOR UPDATE (ADR-008, money rule 8)
    Svc->>DB: lock order row; re-check status
    alt not payable
      Svc-->>Pat: 409 ORDER_NOT_PAYABLE / ORDER_EXPIRED / ALREADY_PAID
    end
    Note over Svc,DB: idempotency: same key returns the existing payment; different key on a paid order gives 409 ALREADY_PAID / IDEMPOTENCY_CONFLICT
    Svc->>Money: recompute split from order + line DB snapshots
    Money-->>Svc: subtotal, per-line cogs/fee/margin
    Svc->>Gw: charge(amount, idempotencyKey)
    alt declined (amount == 1313c stub trigger)
      Gw-->>Svc: declined
      Svc-->>Pat: 402 PAYMENT_DECLINED - order stays sent, NO payment, NO journal
    else succeeded
      Gw-->>Svc: stub_ch_uuid
      Svc->>DB: insert payment (order_id unique, idempotency_key)
      Svc->>DB: insert journal(type=PAYMENT)
      Note over Svc,DB: per line, debit positive, credit negative:<br/>CASH_CLEARING +total, COGS_RECOVERY -cogs,<br/>PROVIDER_PAYABLE -margin, PLATFORM_FEE_REVENUE -fee
      Svc->>DB: insert ledger_entries (per line, each journal sums to 0)
      Svc->>DB: inventory sale: on_hand -qty, reserved -qty, movement reason=sale
      Svc->>DB: UPDATE order status=paid, paid_at; order_events(sent to paid)
      Note over DB: deferred trigger verifies journal balance = 0 at COMMIT
    end
  end
  Svc-->>Pat: 200 payment result (patient-safe)
```

Per-line PAYMENT journal (sign convention debit positive, from `docs/ARCHITECTURE.md`
section 5):

| Account | Amount |
|---|---|
| CASH_CLEARING | +total |
| COGS_RECOVERY | -cogs |
| PROVIDER_PAYABLE | -margin |
| PLATFORM_FEE_REVENUE | -fee |

Every journal sums to zero and is enforced at commit by the deferred
`ledger_entries_balanced` trigger (migration 5, which IS merged).

Source (spec): `docs/ARCHITECTURE.md` sections 5 and 8, `docs/DECISIONS.md` ADR-007/008,
AGENTS.md section 3 rules 6-9. Source (stub, merged): `apps/api/src/payments/router.ts`
(501), `apps/api/src/seams/paymentGateway.ts` (`DECLINE_AMOUNT_CENTS = 1313`),
`apps/api/src/db/migrations/20261005120005_protections.ts` (zero-sum trigger).

---

## 5. Sequence - refund (SPECIFIED, NOT YET MERGED - T5)

**Not built.** `POST /api/orders/:id/refund` and `POST /api/admin/orders/:id/refund` are
501 stubs and there is no `apps/api/src/refunds/` directory on `main`. Drawn from ADR-012
(patient gets 100% back; platform fee retained and charged to the provider), ADR-013
(restock before fulfilment, write off after), ADR-014 (whole-order only), and the money
`refund()` helper, which IS merged in `packages/money`.

```mermaid
sequenceDiagram
  autonumber
  actor Op as Provider or Cerbo Admin
  participant API as refund route (SPEC, 501 today)
  participant Svc as refund service (SPEC)
  participant Money as packages/money refund() (MERGED)
  participant DB as Postgres
  participant Gw as PaymentGateway.refund (stub)

  Op->>API: POST .../orders/:id/refund { reasonCode }
  API->>Svc: refund(orderId, reasonCode)
  rect rgb(235,245,255)
    Note over Svc,DB: ONE transaction, order row lock
    Svc->>DB: load paid order + snapshot split; re-check status
    alt not paid
      Svc-->>Op: 409 NOT_REFUNDABLE
    else already refunded
      Svc-->>Op: 409 ALREADY_REFUNDED
    end
    Svc->>Money: refund(orderSplit)
    Money-->>Svc: patientAmount=subtotal, cogsReturned=cogs,<br/>providerDebit=margin+fee, feeRetained=fee
    Svc->>Gw: refund(gatewayRef, patientAmount)
    Svc->>DB: insert journal(type=REFUND)
    Note over Svc,DB: REFUND entries: CASH_CLEARING -total,<br/>COGS_RECOVERY +cogs,<br/>PROVIDER_PAYABLE +margin (margin_reversal) +fee (fee_retention);<br/>PLATFORM_FEE_REVENUE untouched - sums to 0
    Svc->>DB: insert ledger_entries (per line)
    alt before fulfilment (ADR-013)
      Svc->>DB: restock: on_hand +qty, movement reason=refund_restock; refunds.restocked=true
    else after fulfilment (fulfilled_at set)
      Svc->>DB: NO restock; refunds.writeoff_cogs_cents = cogs (Cerbo bears COGS)
    end
    Svc->>DB: insert refund row (amount, fee_retained, reason); UPDATE order status=refunded; order_events(paid to refunded)
  end
  Svc-->>Op: 200 refund result
```

ADR-012: the patient receives 100% of the subtotal; `PLATFORM_FEE_REVENUE` is NOT reversed
on a refund, so the provider absorbs the fee and Cerbo keeps it (the provider ends at
`-fee` for that order). ADR-013: a pre-fulfilment refund restocks; a post-fulfilment refund
writes off the COGS and Cerbo bears it. Whole-order refunds only (ADR-014).

Source (spec): `docs/DECISIONS.md` ADR-012/013/014, `docs/ARCHITECTURE.md` section 5.
Source (merged helper): `packages/money/src/refund.ts`. Source (stub, merged):
`apps/api/src/orders/router.ts` (refund 501).

---

## 6. Sequence - reservation expiry job (MERGED)

The in-process timer (and the admin endpoint for deterministic demos) sweeps `sent` orders
whose `reservation_expires_at` has passed, releases their reserved stock, and moves them to
`expired`. Each order is re-locked and re-checked under its own transaction so a second run
or the admin endpoint firing concurrently can never double-release (EVAL-14).

```mermaid
sequenceDiagram
  autonumber
  participant Trig as 60s timer OR POST /api/admin/jobs/expire-reservations
  participant Job as jobs/expire.ts runExpireReservations
  participant Clock as Clock seam
  participant DB as Postgres
  participant Inv as inventory/service.ts releaseLines

  Trig->>Job: runExpireReservations(db, clock)
  Job->>Clock: now()
  Job->>DB: SELECT id FROM orders WHERE status=sent AND reservation_expires_at lte now (unlocked candidates)
  loop each candidate id
    rect rgb(235,245,255)
      Note over Job,DB: own transaction, order row lock
      Job->>DB: SELECT order FOR UPDATE; re-check status=sent AND still expired
      alt no longer sent or not yet expired
        Job->>DB: skip (paid/cancelled/already expired since listing)
      else still expiring
        Job->>Inv: releaseLines(lines) lock products, reserved_qty -qty, movement reason=release
        Job->>DB: UPDATE order status=expired, expired_at; order_events(sent to expired)
      end
    end
  end
  Job-->>Trig: { expired: [ids] }
```

Note: the admin endpoint `POST /api/admin/jobs/expire-reservations` is a 501 stub on
`main` today, but the underlying `runExpireReservations` job function is merged and real.
The expiry logic shown is the merged code.

Source: `apps/api/src/jobs/expire.ts`, `apps/api/src/inventory/service.ts`
(`releaseLines`), `apps/api/src/seams/clock.ts`.

---

## 7. Money split flow (MERGED, packages/money)

The algorithm: compute the order fee once, half-up, then allocate it across lines by
largest remainder with ties broken by position ascending; derive per-line margin; reject
the whole split if any line margin is negative. Invariants: `cogs + fee + margin = total`
per line and per order, and `margin >= 0`.

```mermaid
flowchart TB
  start(["split(lines, feeBps=75)"]) --> validate["validate: each qty, unitPriceCents,<br/>unitCogsCents safe positive int; position gte 0"]
  validate --> totals["per line: total = qty * unitPriceCents<br/>cogs = qty * unitCogsCents"]
  totals --> subtotal["subtotal = sum(total)<br/>totalCogs = sum(cogs)"]
  subtotal --> fee["orderFee = floor((subtotal * feeBps + 5000) / 10000)<br/>HALF-UP, once per order"]
  fee --> alloc["allocateFee: for each line<br/>num = orderFee * total<br/>base = floor(num / subtotal)<br/>rem = num mod subtotal<br/>leftover = orderFee - sum(base)"]
  alloc --> distribute["give +1 to the leftover lines<br/>with largest rem; ties to lower position first"]
  distribute --> margin{"per line:<br/>margin = total - cogs - fee<br/>margin lt 0 ?"}
  margin -- yes --> err["throw MARGIN_NEGATIVE<br/>(reports position) then 422"]
  margin -- no --> ok["return per-line total/cogs/fee/margin<br/>+ order totals"]
  ok --> inv["INVARIANTS hold:<br/>sum(line fee) = orderFee<br/>cogs + fee + margin = total<br/>margin gte 0"]
```

### Worked example (EVAL-01)

`prov-ana` order for `pat-cara`: MAG-GLY-120 x2 @ 2999 (unit COGS 1450), VITD3-K2 x1 @ 2499
(unit COGS 1125). feeBps = 75.

```mermaid
flowchart TB
  l1["Line 1 (pos 1): MAG-GLY-120 x2 @ 2999<br/>total = 5998, cogs = 2x1450 = 2900"]
  l2["Line 2 (pos 2): VITD3-K2 x1 @ 2499<br/>total = 2499, cogs = 1125"]
  l1 --> sub["subtotal = 5998 + 2499 = 8497<br/>totalCogs = 4025"]
  l2 --> sub
  sub --> f["orderFee = floor((8497 * 75 + 5000)/10000)<br/>= floor(642275/10000) = floor(64.2275) = 64"]
  f --> a1["Line 1: num = 64 x 5998 = 383872<br/>base = floor(383872/8497) = 45, rem = 1507"]
  f --> a2["Line 2: num = 64 x 2499 = 159936<br/>base = floor(159936/8497) = 18, rem = 6990"]
  a1 --> lo["baseSum = 45 + 18 = 63<br/>leftover = 64 - 63 = 1"]
  a2 --> lo
  lo --> win["largest rem = 6990 (line 2) gets the +1<br/>line fees = 45 and 19"]
  win --> m["margins:<br/>line 1 = 5998 - 2900 - 45 = 3053<br/>line 2 = 2499 - 1125 - 19 = 1355<br/>order margin = 4408"]
  m --> chk["check: fees 45 + 19 = 64 = orderFee OK<br/>cogs 4025 + fee 64 + margin 4408 = 8497 = subtotal OK"]
```

Source: `packages/money/src/fee.ts` (`orderFee`), `packages/money/src/allocate.ts`
(`allocateFee`), `packages/money/src/split.ts` (`split`), `packages/money/src/refund.ts`,
`packages/money/src/pricing.ts` (`priceFromMarkupCents`; EVAL-01 prices come from markups 1526
and 1355 at these COGS). Expected values from
`docs/EVALS.md` EVAL-01.

---

## Status at time of writing

Factual breakdown of what the diagrams reflect. "Merged" = present and real on `main`.

**Merged and drawn from real code:**
- `packages/money`: `fee`, `allocate`, `split`, `refund`, `pricing`, `validate` (diagram 7).
- T2 schema: all five migrations and the seed, gate G2 (diagram 2).
- T0 shell: `app.ts` route registry, auth middleware/guards, seam interfaces + stubs,
  `apps/web/src/router.ts` (diagram 1).
- T3 order lifecycle: `orders/service.ts` and `router.ts` (draft, add/update/delete line,
  quote, send, cancel, list) and `inventory/service.ts` (reserve, release, availability),
  plus `patients` GET (diagram 3).
- Reservation expiry job: `jobs/expire.ts` is merged and real (diagram 6).
- T6 provider UI: `OrderBuilder.vue`, `Orders.vue`, and `OrderAudit.vue` are implemented
  views.
- Deployment: `Dockerfile`, `railway.json`, `.gitlab-ci.yml` `deploy-railway` job, gate G5
  (diagram 1, Railway section). The live deploy path was verified end to end (T12).

**In human review, NOT merged (drawn from spec, labeled as such):**
- T4 payment + ledger posting + audit endpoint (gate G3). `payments/router.ts` is a 501
  stub; there is no `ledger/` directory; `GET /api/orders/:id/audit` is a 501 stub.
  Diagram 4 is drawn from `docs/ARCHITECTURE.md` section 5 and ADR-007/008. The
  `OrderAudit.vue` view exists, but its backing audit endpoint does not.

**Not built (drawn from spec where shown, labeled as such):**
- T5 refund (diagram 5): refund routes are 501 stubs; no `refunds/` directory. The
  `packages/money` `refund()` helper it will call is merged.
- T9 recurring: `schedules` routes are 501 stubs; `Recurring.vue` and
  `ScheduleAuthorize.vue` are placeholders. No recurring diagram is drawn.
- Reports (sales, payables): routes are 501 stubs; provider `Dashboard.vue` and
  `Payables.vue` are placeholders.
- All Cerbo Admin endpoints (inventory restock, metrics, payables close, operations
  fulfill/refund, demo baseline/reset/jobs): 501 stubs; admin views are placeholders. The
  admin `expire-reservations` job endpoint is a stub even though the job function is merged.
- Patient `Pay.vue` is a placeholder (the payment UI is not built).

No conflict between the docs and the merged code was found while drawing these diagrams.
Where the code is absent, the diagram is labeled SPECIFIED, NOT YET MERGED and cites the
spec section it is drawn from.
