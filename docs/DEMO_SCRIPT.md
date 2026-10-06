# DEMO_SCRIPT.md - Live walkthrough by role

A step-by-step script someone can follow live without improvising. It uses the exact
seed data, so the expected numbers are printed at every step; if a number on screen does
not match, something is wrong and you can see it immediately.

> Status note (2026-10-06): every step below is implemented and merged to `main`, including
> recurring orders and all the Cerbo Admin screens (nothing is cut). Run the live demo against
> the deployment produced by the final merge-to-`main`; if you are demoing before that deploy
> lands, run locally. The expected numbers come from `docs/EVALS.md` and the CI-verified
> `tests/e2e/RESULTS.md` (PASS 43, FAIL 0, CUT 0). The final UI follow-up (styling, DEMO badges on
> admin views, the pay-link copy control, and the My Orders list) has merged; the only caveat is
> that the author has not clicked through every styled screen, so the owner confirms visual polish
> live at gate G5.

## Before you start

- Local: run the five setup commands in `README.md` and open http://localhost:5173.
- Live: open https://cerbo-api-production.up.railway.app and confirm
  https://cerbo-api-production.up.railway.app/api/health returns
  `{"status":"ok","db":{"connected":true}}`.
- Use the top-bar role switcher to change role. It sets the `X-Demo-User` header; there is
  no login. The seeded users are:

| Role | Switcher entry | Practice |
|---|---|---|
| Provider | Dr. Ana Reyes (`prov-ana`) | Riverside Integrative |
| Provider | Dr. Ben Cole (`prov-ben`) | Summit DPC |
| Patient | Cara Lopez (`pat-cara`) | Riverside |
| Patient | Dev Patel (`pat-dev`) | Summit |
| Cerbo Admin | Cerbo Admin (`admin-cerbo`) | - |

The seeded catalog (5 SKUs). Note the two deliberate stock-failure SKUs:

| SKU | Name | unit COGS (cents) | on_hand | Use in demo |
|---|---|---|---|---|
| MAG-GLY-120 | Magnesium Glycinate 120ct | 1450 | 50 | main order |
| VITD3-K2 | Vitamin D3 + K2 | 1125 | 40 | main order, margin floor, decline |
| OMEGA3-1000 | Omega-3 Fish Oil 1000mg | 2280 | 30 | spare |
| PROBIO-50B | Probiotic 50B CFU | 2675 | 5 | low-stock failure |
| ZINC-30 | Zinc Picolinate 30mg | 690 | 0 | out-of-stock failure |

The whole demo centers on one order, the canonical EVAL-01 order, because its numbers are
fixed and easy to check: **MAG-GLY-120 x2 @ 2999 and VITD3-K2 x1 @ 2499.**

## Act 1 - Provider builds and sends an order

Switch to **Dr. Ana Reyes**. Open **New Order** and pick patient **Cara Lopez**.

1. Add **MAG-GLY-120, quantity 2, price 2999** (that is $29.99 per unit).
2. Add **VITD3-K2, quantity 1, price 2499**.

The live quote should read exactly:

| Line | Total | COGS | Fee | Net margin |
|---|---|---|---|---|
| MAG-GLY-120 x2 @ 2999 | 5998 | 2900 | 45 | 3053 |
| VITD3-K2 x1 @ 2499 | 2499 | 1125 | 19 | 1355 |
| **Order** | **8497** | **4025** | **64** | **4408** |

Talking points while this is on screen:
- The fee is 0.75% of the 8497 subtotal, rounded half-up, computed once: 64 cents.
- The 64 is split to the lines as 45 and 19, which add back to 64 exactly. No drift.
- Each line satisfies `cogs + fee + margin = total`, and margin is never negative.

Optional - **margin percent mode.** Instead of typing a price for MAG-GLY-120, type a
margin of 50% (5000 bps). The derived unit price should be exactly **2900**. (The formula is
`ceil(cogs * 10000 / (10000 - marginBps))`.) Switch it back to 2999 for the rest of the demo.

Now click **Send**. The order moves to `sent`, stock for the two SKUs is reserved, and the
UI shows a **copyable patient pay link** (the Notifier stub also logs the link to the server
console). The patient uses this link in Act 3.

You do not have to copy the link at this exact moment. It can be recovered later from the
provider **Orders** list and from the order **Audit** view (both render a copy control bound to
the order's pay path), so if you miss it or it scrolls away you can get it back. The link is also
in the send response and the server console log.

## Act 2 - The guardrails (show these fail on purpose)

These are quick, deliberate failures. They prove the system refuses bad states instead of
silently accepting them.

**Low stock.** In a draft order, add **PROBIO-50B, quantity 6**. Expected: rejected with
`INSUFFICIENT_STOCK`, and the alert "On-hand stock cannot meet this quantity (available: 5).
Wait for restock or reduce quantity." Change it to **quantity 5** and it is accepted (exactly
5 are in stock).

**Out of stock.** Add **ZINC-30, quantity 1**. Expected: `INSUFFICIENT_STOCK`, available 0.
ZINC-30 is visible but marked unavailable.

**Margin floor.** Add **VITD3-K2, quantity 1, price 1125** (equal to its COGS). Expected:
rejected with `MARGIN_NEGATIVE` naming the line - after its fee the margin would be -8 cents.
Raise the price to **1133** and it is accepted at exactly margin 0. This is the "a provider
never unknowingly sells at a loss" point.

Remove these test lines before continuing, or just start the Act 1 order fresh.

## Act 3 - Patient pays

The patient pay web page (T7) and its backend routes are implemented and merged.

Switch to **Cara Lopez** (or open the copied pay link - patient pages are reached by the
unguessable token, not the role switcher). On the pay page the patient sees only
patient-safe fields: item names, quantities, unit prices, line totals, and the order total
**8497**. There is no COGS, no fee, and no margin anywhere on this page - that is the privacy
whitelist (EVAL-12).

Click **Pay**. Expected result:
- The order moves to `paid`; exactly one payment and one PAYMENT journal are created.
- Stock is sold: **MAG-GLY-120 on_hand 50 -> 48, VITD3-K2 on_hand 40 -> 39**, reserved back
  to 0.
- The PAYMENT journal posts `CASH +8497, COGS -4025, PROVIDER_PAYABLE -4408,
  PLATFORM_FEE_REVENUE -64`, and the journal sums to zero.

Idempotency talking point: the Pay button generates one idempotency key per page load.
Clicking twice returns the same payment, not a second charge. A different key on an
already-paid order returns `ALREADY_PAID`.

**The decline demo (optional).** The payment gateway stub declines any charge of exactly
**1313 cents**. To show it, build a separate order of **VITD3-K2 x1 @ 1313** (subtotal 1313),
send it, and pay. Expected: **402 PAYMENT_DECLINED**, the order stays `sent`, and no payment
or journal is created. Any other amount succeeds.

You can also drive the payment from the API directly:
`POST /api/pay/<token>` with a JSON body `{ "idempotencyKey": "<any-unique-string>" }`.

## Act 4 - Provider views the audit

Switch back to **Dr. Ana Reyes**, open **Orders**, pick the EVAL-01 order, and open its
**Audit** view. It renders:
- The order snapshot and every line with every amount (total, COGS, fee, margin).
- Status history: **draft -> sent -> paid**.
- The payment and the PAYMENT journal with its four per-line entries.
- Inventory movements (reserve at send, sale at pay).
- An **invariants block** where each check passes or fails explicitly. For this order every
  check should read `pass`: `cogs + fee + margin = total` at order and line level, journal
  sums to zero, line fees sum to order fee.

This is the "every cent is traceable" moment. Point at the invariants block.

## Act 5 - Refund

As **Dr. Ana Reyes** (or Cerbo Admin), refund the paid EVAL-01 order with reason
`patient_request`. Expected (EVAL-07, a CI-verified pass), because this order was not
fulfilled:
- Refund amount **8497** (the patient gets 100% back).
- REFUND journal: `CASH -8497, COGS +4025, PROVIDER_PAYABLE +4472` posted as two entries,
  **4408 margin_reversal + 64 fee_retention**. `PLATFORM_FEE_REVENUE` is untouched - Cerbo
  keeps the fee. The journal sums to zero, and the original PAYMENT journal is left exactly as
  it was (corrections are new entries, never edits - ADR-007).
- Because it was not fulfilled, stock is restocked: **MAG-GLY-120 back to 50, VITD3-K2 back
  to 40**. `fee_retained` is 64. Order status becomes `refunded`.
- A second refund returns `ALREADY_REFUNDED`.

Talking point, and say it plainly: the provider ends this order at **-64 cents**. The patient
got everything back, Cerbo kept its 64-cent fee, and the provider is debited both the margin
it earned and that fee - so the provider genuinely eats the fee on a refund. That is ADR-012;
it mirrors how card processors keep their fee on refunds and, per DECISIONS.md, must be
disclosed in provider terms.

Post-fulfillment contrast (optional, EVAL-08, also a CI-verified pass): pay the EVAL-02 order
(OMEGA3-1000 x1 @ 4999), fulfill it, then refund with reason `damaged`. There is **no restock**
(OMEGA3-1000 stays at 29) and `writeoff_cogs_cents` records **2280** - Cerbo bears the full
COGS. That is the post-fulfillment refund risk called out in the README.

## Act 6 - Provider reports

Still as **Dr. Ana Reyes**, open **Payables**. For the month in which the EVAL-01 order was paid
and then refunded, the report shows **credits 7090, debits 4472, closing 2618** (EVAL-09b, a
CI-verified pass). The refunded EVAL-01 order nets the provider to -64 inside those figures.

Closed-month behaviour (EVAL-10, also verified): if a statement is closed in month M and a refund
is posted later, the M statement stays frozen at **credits 4408** while the later refund shows up
as **debits 4472, closing -64** in the current period. Closed statements are never rewritten
(ADR-014). This is the point about late refunds not rewriting history.

Open the **Dashboard** for the same range. It shows GMV, refunded GMV, settled GMV, platform fee
revenue, and net margin, all read from the ledger rather than recomputed from order lines.

## Act 7 - Cerbo Admin oversight and metrics

Switch to **Cerbo Admin**.

- **Audit, fulfill, or refund any order.** Cerbo Admin can open the audit for any order (`GET
  /api/admin/orders/:id/audit`), fulfill a paid order, and refund any order - the same backend
  used in Acts 4 and 5, but not scoped to one practice.
- **Metrics with the reconciliation check (EVAL-09, CI-verified).** Open **Metrics**. For the
  month that holds the EVAL-01 order (paid then refunded) and the EVAL-02 order (paid, fulfilled,
  refunded as the write-off example), grouped by provider, the figures are GMV **13496**,
  refunded **8497**, settled **4999**, platform fee revenue **101**, sunk fees **64**, provider
  net margin **2682**, and net after sunk fees **2618**. The reconciliation line reads **pass** -
  it recomputes provider margin per order from the owner's formula and confirms it matches the
  ledger cents (ADR-015).
- **Synthetic toggle.** The **Include synthetic demo data** toggle defaults OFF. With it off the
  numbers above are unchanged; flip it on and the synthetic demo activity (Act 9) is included and
  the migration percentage appears.

## Act 8 - Recurring orders

Still useful to show from the provider side. Switch to **Dr. Ana Reyes** and open **Recurring**.

- Create a schedule for **Cara Lopez**: **MAG-GLY-120 x1 @ 2999**, interval 30 days. The patient
  authorizes once via their schedule pay link (stubbed saved payment method).
- Run one cycle (the provider "Run cycle" action). Expected (EVAL-11): a child order of kind
  `recurring_cycle` is created and paid, with **fee 22, margin 1527**, and MAG-GLY-120 on-hand
  drops by 1. It uses the same payment and posting path as a one-off order, so it is fully
  auditable.
- The `on_hold` story (ADR-017), any one of these:
  - Schedule **PROBIO-50B x6** and run: the cycle is parked **on_hold, INSUFFICIENT_STOCK**, no
    journal, stock untouched (EVAL-11b).
  - Run an **unauthorized** schedule: **on_hold, NOT_AUTHORIZED** (EVAL-11c).
  - Raise a product's COGS so margin would go negative, then run: **on_hold, MARGIN_NEGATIVE**
    (EVAL-11d).
  The point: a cost increase or a stock shortage parks the cycle with a reason instead of silently
  charging the patient or eating the provider's margin.

## Act 9 - Demo data, migration, and the guarded reset

As **Cerbo Admin**, open **Demo Data**. These tools exist to make the metrics demo realistic and
are all marked with the DEMO badge.

- **Import a baseline** (or regenerate a synthetic one): historical marketplace GMV per provider.
  Rows are validated one at a time; a bad row is reported, not inserted.
- **Generate synthetic migration activity.** It runs through the real split and posting code,
  backdated via the `Clock` seam and flagged `is_synthetic`, and it does not touch inventory. Go
  back to **Metrics**, turn **Include synthetic** on, and the **migration percentage** now appears
  (in-house GMV against the baseline monthly average, ADR-018).
- **Reset demo data.** This purges only `is_synthetic` rows, through the one guarded append-only
  exception. Real orders, payments, and ledger entries are untouched, and `payable_statements` can
  never be deleted even with the purge flag set (EVAL-13, RT-14). After reset, turn the synthetic
  toggle off and the real numbers from Act 7 are exactly as they were.
- **Production guard.** With `DEMO_MODE=false`, every `/api/admin/demo/*` endpoint returns **403
  DEMO_DISABLED** (EVAL-15). The live demo runs with `DEMO_MODE=true`.

## Act 10 - Inventory restock (demo only)

As **Cerbo Admin**, open **Inventory**. Raise **ZINC-30** on-hand from 0 to, say, 20. It is
recorded as an inventory movement with the actor, and the control carries a **DEMO** badge because
real stock would come from procurement, not a button (ADR-009). Switch to a provider and confirm
the provider has no restock control - the API returns **403** if a provider calls it (RT-09). Now
a ZINC-30 order that failed in Act 2 would succeed.

## If something fails mid-demo

In priority order (full detail in `docs/DEPLOY.md`):

1. **Railway dashboard "Redeploy"** on the last successful deployment. This re-runs the
   already-built image in seconds with no rebuild - use this first if the live site dies
   mid-demo.
2. **Re-run the pipeline on `main`** in the GitLab UI (or `glab api --method POST
   "projects/2107/pipeline?ref=main"`). This rebuilds from source and redeploys, a few
   minutes.
3. **A fresh merge to `main`** also triggers a redeploy.

If a specific step misbehaves rather than the whole site:
- Wrong numbers on a quote or audit: you are almost certainly not on the seeded database.
  Re-run `npm run db:seed` locally, or confirm the live DB was seeded (health is green and
  the catalog shows all 5 SKUs).
- Patient page shows an error: check the pay token in the URL is the full, unmodified string
  from the provider's copyable link.
- A guardrail step "passes" when it should fail: confirm you used the exact quantities and
  prices above (PROBIO x6, ZINC x1, VITD3 @ 1125).

Fallback if the live site cannot be recovered in time: run the whole script locally against
`http://localhost:5173`, which does not depend on Railway at all.

## What is verified, and the remaining caveats

Every act above is implemented and merged, and every figure tied to an EVAL id is CI-verified
against real Postgres. The id-by-id results are in `tests/e2e/RESULTS.md` (**PASS 43, FAIL 0,
CUT 0** - every id in the specification). Nothing in the plan is cut.

The one caveat is visual, not behavioural: the final UI follow-up (styling pass, DEMO badges on
the admin views, the pay-link copy control, and the My Orders list rendering real data) has
merged, but the author of this script has not personally clicked through every styled screen. The
underlying endpoints and data all work and are tested. Treat the visual polish as merged and
owner-confirmed at gate G5 rather than author-verified.

One honesty note on the numbers: the single `POST /api/admin/jobs/run-due-schedules` admin button
is still a 501 stub, so run recurring cycles from the provider **Recurring** screen's "Run cycle"
action (Act 8), which is wired and tested, not from that admin button.
