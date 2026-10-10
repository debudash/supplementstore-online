# Cerbo In-House Supplement Ordering

A provider assembles a supplement order for a patient inside the EHR, the patient
pays Cerbo directly through a link, and every cent is split and recorded in an
append-only double-entry ledger: cost of goods to Cerbo, margin to the provider,
and a 0.75% platform fee to Cerbo.

This is a vertical slice rather than a full product. It covers the core money flow end to end
(order, payment, ledger, audit, refund) plus recurring orders, admin metrics and
a migration report. Every external integration sits behind a stub interface.

Live demo: https://cerbo-api-production.up.railway.app
Health endpoint: https://cerbo-api-production.up.railway.app/api/health

## The problem

Cerbo's providers send patients to third-party supplement marketplaces today. Bringing
that ordering in-house means Cerbo holds the inventory, the provider prices each item,
the patient pays Cerbo, the provider is paid their margin, and Cerbo keeps a small
platform fee. The numbers that matter are platform fee revenue (GMV x 75 bps) and how
much ordering volume moves off the marketplaces.

The hard part isn't the storefront. It's making the money mechanics correct and
auditable, so that's where most of the effort went.

## Setup and run (local)

Prerequisites: Node 20 LTS and Docker (for local Postgres).

```
npm install                 # install all workspaces
docker compose up -d db     # start local Postgres 16 on :5432
npm run db:migrate          # apply Knex migrations
npm run db:seed             # load the 5-SKU catalog, 2 practices, 5 users
npm run dev                 # api on :3000, web on :5173 (Vite proxies /api -> :3000)
```

Open http://localhost:5173 and use the top-bar role switcher to act as a provider,
a patient, or Cerbo Admin. The switcher sets the `X-Demo-User` header; there is no
real login (see "What is stubbed").

Other commands:

```
npm run lint                # eslint across the repo
npm run typecheck           # builds packages/* then typechecks every workspace
npm test                    # unit (packages/money) + api (apps/api) + web (apps/web) tests
npm run test:e2e            # scenario evals in tests/e2e against Postgres
npm run build               # build packages, apps/web (Vite), apps/api (tsc)
```

Copy `.env.example` to `.env` (and to `apps/api/.env`, which the db scripts and the api
dev server read). The defaults match `docker-compose.yml`
(`DATABASE_URL=postgres://postgres:postgres@localhost:5432/cerbo`, `PORT=3000`,
`DEMO_MODE=true`).

To run the same checks as CI before pushing (Windows PowerShell; starts the `db`
container if needed):

```
powershell -ExecutionPolicy Bypass -File scripts/local-check.ps1
```

It runs lint, typecheck, build, `npm test` and `npm run test:e2e`, giving the unit and
e2e suites separate fresh databases (`cerbo_test`, `cerbo_e2e`). Running both suites
against one database can fail EVAL-13 on leftover data even when the code is fine.

Notes:
- The api test suites run serially against the shared Postgres (they mutate global
  stock and pin the seeded product set), so do not parallelize them.
- `npm run db:seed` is a no-op on an already-seeded database.

## Deployment

The app is one Docker image (multi-stage: build the Vue SPA and the API, then a slim
runtime that serves both) plus a Railway Postgres database. On boot the container runs
Knex migrations, seeds the catalog if the products table is empty, and listens on the
Railway-provided `PORT`. `GET /api/health` returns 200 only when the database is reachable and the catalog is seeded.

The repo lives on self-hosted GitLab, and Railway's deploy-on-push only supports GitHub,
so a `deploy-railway` job on `main` runs `railway up` and then polls the live
`/api/health` URL. The health poll is the real gate: `railway up` returns as soon as the
build is queued, so on its own it reports green for a release that crash-loops. Details
are in `docs/DEPLOY.md`, including how to recover with a Railway "Redeploy" if the live
site goes down.

### What CI enforces

- **Strict `npm ci`**: the lockfile must be in sync, which is what the Railway build needs.
- **Float-money guard**: fails the build if `.toFixed(`, `parseFloat(` or
  `Number.parseFloat(` appears in money, ledger, payment, refund, report or order code.
- **Protected-path guard**: changes to the spec, decision log and invariant tests need an
  explicit approval label, so nothing can quietly weaken a test or a spec.
- **End-to-end eval and red-team suite**: its own `e2e` job against real Postgres, no
  `allow_failure`. A failing case blocks the deploy.
- **Post-deploy health poll**: fails the deploy if the live site does not return 200.

Docs-only merge requests skip `build-test` and `e2e` (the guards still run), and `main`
always reruns the full suite before deploying.

## The money model

All the money rules are simple enough that a non-engineer can check them, and no cent can
be lost to rounding.

- **Integer cents only.** `$29.99` is stored as `2999`. No floats anywhere in the money path.
- **The provider sets a dollar markup per unit; the server derives the price.** The patient
  pays COGS + markup + the 0.75% fee, and the order is rounded once:
  `need = sum(qty x (cogs + markup))`, `subtotal = ceil(need * 10000 / (10000 - 75))`.
  Because the subtotal and the fee are both rounded up, `subtotal - need = fee` exactly,
  and the provider nets exactly qty x markup on every line.
- **One fee per order.** `fee = ceil(subtotal * 75 / 10000)`: never below 0.75%, at most
  1 cent above. For a subtotal of 8497 cents the fee is 64 cents.
- **Split back to lines by largest remainder.** Line totals always add back up to the order
  total, and line fees add up to the order fee (for the 8497-cent order: 45 + 19 = 64).
  Ties are broken by line position.
- **The invariant:** for every order and every line, `cogs + fee + margin = total` and
  `margin >= 0`. A line that would break it is rejected with `MARGIN_NEGATIVE` before
  anything is saved.
- **Snapshots, not recomputation.** A draft re-prices from current COGS. Sending an order
  snapshots the unit COGS onto its lines, and a paid order is immutable. Corrections are new
  ledger entries, never edits.

All of this lives in `packages/money` as pure integer functions, with example tests and
10k-run property tests. No other module computes a fee, an allocation, a margin or a
refund amount.

### The ledger

Payments and refunds are append-only double-entry journals over four accounts:

- `CASH_CLEARING`: money moving through Cerbo from the patient.
- `COGS_RECOVERY`: Cerbo recovering its cost of goods.
- `PROVIDER_PAYABLE`: what Cerbo owes the provider.
- `PLATFORM_FEE_REVENUE`: Cerbo's 0.75% fee.

Journals are posted per line, so each cent traces to a SKU, and every journal sums to zero.
Payment posts `CASH +total, COGS -cogs, PAYABLE -margin, FEE -fee`. Database triggers reject
UPDATE and DELETE on the ledger tables (with one narrow exception for purging synthetic demo
rows). The payment status change, the ledger posting and the inventory change happen in one
transaction with a row lock on the order, so concurrent requests can't double charge or
oversell.

## Key decisions

The full log, with the options considered, is `docs/DECISIONS.md`. These shape the product:

- **Fee base and bearer (ADR-001, 002, 028).** The fee is 0.75% of the patient-paid subtotal,
  built into the unit price so the provider keeps their markup. The patient never sees a fee
  line, and it lines up directly with the GMV x 75 bps metric.
- **Round once, allocate by largest remainder (ADR-003).** Per-line rounding drifts by a cent
  or two. This approach doesn't.
- **Margin floor (ADR-004).** A line's margin after its fee must be >= 0, so a provider can
  never unknowingly sell at a loss.
- **Snapshot at send, immutable once paid (ADR-006).** Catalog cost changes never rewrite
  history.
- **Append-only, per-line, trigger-enforced ledger (ADR-007).**
- **Idempotent pay in a single locked transaction (ADR-008).**
- **One inventory pool under Cerbo (ADR-009).** The brief asks for the provider dashboard to
  "update inventory", but it also says Cerbo holds the inventory, and a single pool is shared
  by every practice. A provider restock would change stock for everyone else, so restock is a
  Cerbo Admin action. Providers see each product's stock (in stock, low, out) as they add it
  to an order, and the dashboard shows what they have sold.
- **Stock checked three times (ADR-011).** At add-to-cart, reserved at send (7-day expiry),
  and rechecked at pay. Checking only at add-to-cart allows oversell while orders sit unpaid.
- **Refunds return 100% to the patient; Cerbo keeps the fee and charges it to the provider
  (ADR-012).** This mirrors how card processors handle refunds. It is the decision most likely
  to surprise a provider, so it needs to be in the provider terms.
- **Refund before fulfillment restocks; after fulfillment it does not (ADR-013).** Returned
  ingestibles aren't resellable, so a post-fulfillment refund writes off the COGS.
- **Whole-order refunds; late refunds post to the current period; closed statements are never
  rewritten (ADR-014).**
- **Metrics are summed from ledger cents (ADR-015).** A single blended margin percent misstates
  profit when margins vary, so the blended formula is only used as a per-order reconciliation
  check.
- **Recurring orders generate one child order per cycle (ADR-017).** Each cycle takes a fresh
  COGS snapshot, so a cost rise passes through to the patient. If stock is short or the
  schedule isn't authorized, the cycle is parked `on_hold` with a reason instead of charging
  anyway.
- **Migration is measured against a CSV-imported baseline (ADR-018).** In-house GMV divided by
  the baseline monthly average.
- **Patients can request refunds for unopened products within 30 days (ADR-027).** The provider
  accepts or declines from a review link. No physical returns: the patient keeps or disposes of
  the product.

## What is stubbed

Every external integration is behind an interface in `apps/api/src/seams/`, so a real one can
replace it without touching business logic:

- **PaymentGateway**: `charge` / `refund` return a fake `stub_ch_<uuid>`. An amount of exactly
  1313 cents forces a decline so the declined path can be demoed. A real gateway would create
  a PaymentIntent and confirm by webhook through the same posting function.
- **FulfillmentService**: `markFulfilled` sets `fulfilled_at`. A 3PL or shipping API would go
  here.
- **Notifier**: logs the patient pay link; the provider UI shows a copyable link instead of
  sending email or SMS.
- **PayoutService**: not called yet.
- **Clock**: system time, except the demo data generator can backdate. This also makes
  reservation expiry testable.

**Auth** is also stubbed. The role switcher sets an `X-Demo-User` header and middleware loads
the actor. Patient pay pages use an unguessable 24-byte token in the URL. Every route still
enforces role and ownership, and a resource the actor doesn't own returns 404 rather than 403
so its existence isn't leaked.

## Features beyond the core flow

Each is covered by API or web tests, and most also by an e2e eval in `tests/e2e/RESULTS.md`.

- **Recurring orders.** A provider creates a schedule (products, quantities, markups, interval).
  Each cycle is a normal order going through the same payment and posting path, so it is fully
  auditable. Problem cycles go `on_hold` with a reason.
- **Cerbo Admin metrics.** GMV, refunded and settled GMV, platform fee revenue, sunk fees,
  provider margin and markup, and migration, all summed from ledger cents, with provider net margin reconciled
  per order against the blended margin formula. Synthetic demo data is excluded by default. Over a multi-month range the
  migration card shows the monthly trend and a per-provider breakdown.
- **Provider dashboard and payables.** Sales count in the month they were paid. Payables
  always show real orders only, so demo data never touches money Cerbo actually owes.
- **Evidence page.** Live integrity checks (balanced journals, per-order invariants, stock
  consistency, append-only guards), unit economics against an adjustable card-processing
  estimate (default 2.9% + 30c) with the break-even fee, and refund exposure by reason.
- **CSV baseline import.** Rows are validated one by one, and bad rows are reported rather
  than inserted.
- **Demo data and reset.** Synthetic history is generated through the real split and posting
  code, backdated with the `Clock` seam and flagged `is_synthetic`. "Reset demo story" purges
  only synthetic rows and regenerates the same fixed-seed story (6-month baseline + 3-month
  ramp). Payable statements can't be deleted even with the purge flag set.
- **Admin restock**, recorded as an inventory movement with the actor (providers get 403).
- **Patient My Orders and refund requests.** Patients see their orders and can request a refund;
  the provider reviews it from the order audit or a review link.
- **Recoverable pay links.** The provider can copy a pay link from the Orders list or the
  order audit at any time, not just at send.

### Lab-informed suggestions (showcase)

The order builder shows a read-only block, "Suggestions from <patient>'s latest labs", that
lists each low marker in the patient's latest lab panel with the related catalog product,
result, range and date. It is decision support for the provider only: no buttons, nothing
stored, never shown to the patient.

![Lab suggestions block on the order builder](docs/images/lab-suggestions-option-c.png)

The panels are simulated for the two seeded patients, and the rules are a small table in
`apps/web/src/demo/labSuggestions.ts` (ADR-029). A production version would move panels and
rules server-side behind provider-scoped access (lab results are PHI), source them from a lab
feed (HL7 v2 / FHIR Observation), get the rules clinically reviewed, and log access. The idea
it illustrates: a platform that already knows the patient, the catalog and the provider's
pricing can turn lab results into explainable suggestions while the order is being built.

### DEMO badges

Every control that exists only to make the slice demonstrable carries a violet **DEMO** badge
with a tooltip explaining what the real system would do instead: the role switcher (auth),
the pay-link copy control (email/SMS), the admin job buttons (a scheduler), restock
(procurement), and the demo data tools. That keeps demo affordances from being mistaken for
product design.

## Limitations and out of scope

- **No real payments, auth, email, shipping or payouts**; no tax, shipping cost,
  multi-currency or multi-location stock.
- **No scheduler.** Recurring cycles run from the provider's "Run cycle now" button, and
  reservation expiry from an admin button. `POST /api/admin/jobs/run-due-schedules` returns
  501 and its admin button is disabled: the sweep function exists but isn't wired to the route yet.
- **Whole-order refunds only.** The ledger and stored per-line fees support line-level
  refunds; the UI and posting path don't exist yet. Return shipping is out of scope.
- **One environment.** Railway runs production only, with `DEMO_MODE=true`. Merging to `main`
  deploys. Real use would add staging and turn demo mode off.
- **Demo-grade guards on a few admin tools.** Restock isn't gated by demo mode, and the
  payables API accepts `includeSynthetic` even though the Payables page always shows real orders only.
- **CI runs on a single self-hosted runner**, so a sleeping machine stalls a pipeline.
- **Metrics run on synthetic volume**, and the baseline comes from a CSV import rather than
  a real marketplace feed.

## What I'd do next

In rough priority order:

1. **Real payments.** Replace the stub gateway with Stripe PaymentIntents confirmed by webhook,
   posting through the same function the stub uses, and price card-processing cost into the fee
   model (see the first business risk).
2. **A scheduler.** Run reservation expiry and due recurring cycles on a schedule, and wire the
   run-due-schedules route that returns 501 today.
3. **Line-level refunds.** The ledger and stored line fees already support them; the UI and
   posting path are the remaining work.
4. **Staging and production split**, with demo mode off in production.
5. **A real migration baseline** from marketplace order history instead of a CSV import.
6. **Real auth and provider payouts** behind the existing seams.

## Business risks

- **Card processing costs more than 0.75%.** If Cerbo absorbs processing fees, orders can lose
  money. The pricing model doesn't solve this, but the Evidence page quantifies Cerbo's net per
  order and the break-even fee.
- **Post-fulfillment refunds cost Cerbo the full COGS**, while the provider only loses the fee.
  The 30-day unopened rule limits patient requests, and reason codes make the exposure
  measurable.
- **Migration is only as good as its baseline**, and the real source for historical marketplace
  volume isn't defined yet.

## Testing

`packages/money` has 40 tests (including property tests), `apps/api` 210, and `apps/web` 122.
The end-to-end suite has 43 golden-scenario and red-team cases, run against real Postgres in CI.
The red-team cases cover IDOR, pay-link token brute force, client-supplied amounts, parallel pay
and refund, concurrent oversell, injection, ledger tampering, and demo tools in production.
Per-case results are in `tests/e2e/RESULTS.md`.

## How AI was used

Claude handled planning and gap analysis, and coding agents wrote most of the implementation
under review, inside the CI guardrails described above. `docs/AI_LOG.md` covers where that
worked and where it went wrong. The useful catches came early: the original requirements left
the fee base, fee bearer and rounding undefined, add-to-cart stock checks allowed oversell, and
a single blended margin formula misstated profit. All three became decisions before any code
was written.

What went wrong was mostly in delivery: a CI config for the wrong provider, a worker merging
money code before a human review gate, a documented deploy path that couldn't work on GitLab,
and two deploys that passed CI while the live site was down. The lesson from the last one is
built into the pipeline now: a green pipeline doesn't prove the system works, so the deploy is
gated on the live health check.

## Repository map

- `packages/money`: pure integer split math (fee, allocation, margin, refund, pricing).
- `packages/contracts`: shared request/response types.
- `apps/api`: Express API, Knex, Postgres, auth stub, seams, jobs.
- `apps/web`: Vue 3 SPA with the role switcher (`src/demo/` holds the lab showcase).
- `tests/e2e`: golden scenario and red-team evals.
- `docs/`: the original brief, spec, architecture, decisions, metrics, evals, red team, deploy,
  diagrams, AI log and demo script (indexed in `docs/README.md`).

A step-by-step demo walkthrough by role, with exact seed figures, is in `docs/DEMO_SCRIPT.md`.
