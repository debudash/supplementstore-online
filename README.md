# Cerbo In-House Supplement Ordering - Vertical Slice

A provider assembles a supplement order for a patient inside the EHR, the patient
pays Cerbo directly through a link, and every cent is split and recorded in an
append-only double-entry ledger: cost of goods to Cerbo, margin to the provider,
and a 0.75% platform fee to Cerbo.

This repository is a vertical slice, not a product. It builds the core money flow
end to end (order, payment, ledger, audit, refund) plus recurring orders, Cerbo Admin
metrics and the migration report, and the demo tooling, and it keeps every external
integration behind a clearly marked stub.

Live demo: https://cerbo-api-production.up.railway.app
Health endpoint: https://cerbo-api-production.up.railway.app/api/health

> Status note (2026-10-08, submission baseline `submission-2026-10-08`): every task in the
> plan is merged, including all of Tier 3, plus the owner's post-plan changes: per-unit dollar
> markup pricing with the fee rounded once per order (ADR-028), the leading-indicator trend
> and Reset demo story, and the DEMO lab-suggestions showcase (ADR-029).
> Tier 3 (recurring orders, admin metrics and demo data, admin inventory and operations)
> was initially cut for time and then reinstated and completed when the build finished
> early, so the cut list is now empty. The eval and red-team suite covers every id in the
> specification - 43 pass, 0 fail, 0 cut - and those counts come from the CI-run suite,
> not a local claim. See "Build status" at the bottom, and "Limitations" for what is
> known not to work.

## The business problem

Cerbo's providers currently send patients to third-party supplement marketplaces.
Cerbo wants to bring that ordering in-house: hold the inventory, let the provider
price each item, take payment from the patient, pay the provider their margin, and
keep a small platform fee. The headline metric the owner cares about is GMV times
75 bps of platform fee revenue, plus a measure of how much ordering volume migrates
off third-party marketplaces.

This slice proves the money mechanics are correct and auditable. It does not try to
be a storefront.

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

Other commands (all defined in `package.json` / the workspace `package.json` files):

```
npm run lint                # eslint across the repo
npm run typecheck           # builds packages/* then typechecks every workspace
npm test                    # unit (packages/money) + api (apps/api) + web (apps/web) tests
npm run test:e2e            # scenario evals in tests/e2e against Postgres
npm run build               # build packages, apps/web (Vite), apps/api (tsc)
```

Copy `.env.example` to `.env` for local overrides. The defaults match
`docker-compose.yml` (`DATABASE_URL=postgres://postgres:postgres@localhost:5432/cerbo`,
`PORT=3000`, `DEMO_MODE=true`). The db scripts and the api dev server load `.env`
from `apps/api`, so copy it there too (`apps/api/.env`).

Before pushing, run CI's `build-test` and `e2e` jobs locally in one command (Windows
PowerShell; it also starts the `db` container if needed):

```
powershell -ExecutionPolicy Bypass -File scripts/local-check.ps1
```

It runs lint, typecheck, build, `npm test` and `npm run test:e2e`, giving the test and
e2e suites their own fresh databases (`cerbo_test`, `cerbo_e2e`) the way CI gives each
job a fresh Postgres. Running `npm test` then `npm run test:e2e` against the same
database can fail EVAL-13 on leftover data even when the code is fine.

Notes:
- The api test suites run serially against the shared Postgres (they mutate global
  stock and pin the seeded product set), so do not parallelize them.
- `npm run db:seed` is seed-if-empty aware: on an already-seeded database it is a
  no-op rather than a duplicate insert.

## How deployment works

The app is one Docker image (multi-stage: build the Vue SPA and the API, then a slim
runtime that serves both) plus a Railway Postgres database. On boot the container runs
Knex migrations to latest, seeds the catalog if the products table is empty, and listens
on the Railway-provided `PORT`. `GET /api/health` returns 200 with database connectivity.

Deployment is through GitLab CI, not a GitHub-style "connect the repo" integration.
Railway's native deploy-on-push supports GitHub only; this repo lives on self-hosted
GitLab (`labs.gauntletai.com`), so a `deploy-railway` job on `main` runs `railway up`,
Railway builds the `Dockerfile`, and the job then polls the live `/api/health` URL and
fails the pipeline if the site does not come up. That health poll - not the `railway up`
exit code - is what actually gates the deploy, because `railway up` returns as soon as
the build is queued, not when the app is healthy. Full detail, including two false-green
traps that were found and fixed, is in `docs/DEPLOY.md`.

Mid-demo recovery: the fastest path if the live deployment dies is the Railway dashboard
"Redeploy" on the last successful deployment (re-runs the built image in seconds, no CI).
See `docs/DEPLOY.md` "Redeploy / recovery".

### What CI enforces

The pipeline is not just a test runner; these checks actively gate `main` and the deploy:

- **Strict `npm ci`** - the committed lockfile must be genuinely in sync (no `npm install`
  fallback), which is what proves the Railway build will succeed.
- **AI-01 float-money guard** - a grep that fails the build if a float-money call
  (`.toFixed(`, `parseFloat(`, `Number.parseFloat(`) appears in the money, ledger, payment,
  refund, report, or order code. It matches call syntax, so a comment merely naming the
  token no longer trips it.
- **AI-03 protected-path guard** - diffs the protected docs and test paths against `main`; any
  change requires explicit human approval, so a worker cannot quietly weaken a test or a spec.
- **The end-to-end eval and red-team suite** runs as its own `e2e` job against real Postgres,
  with no `allow_failure`. A failing EVAL or RT case reds the pipeline and blocks the deploy.
- **A post-deploy health poll** against the live `/api/health` URL fails the deploy job if the
  site does not return 200, which catches a crash-looping release that `railway up` alone
  would report as green.

Fast path (2026-10-08, `docs/DEPLOY.md` "CI fast path"): one pipeline per change (a branch
push with an open MR runs only the MR pipeline), docs-only MRs skip `build-test` and `e2e`
(the guardrails still run), and `main` still re-runs the full suite before deploying.

## The money model, in plain language

Everything about money is designed so a non-engineer can follow it and so no cent is
ever lost to rounding.

- **Integer cents only.** Every amount is an integer number of cents. No floats, no
  `toFixed`, no decimal strings parsed with float math. `$29.99` is stored as `2999`.
- **One fee per order, computed once.** The platform fee is 0.75% (75 basis points) of
  the order subtotal, rounded UP to the cent, computed a single time at the order level:
  `fee = ceil(subtotal * 75 / 10000)`. It is never below 0.75% and at most 1 cent above.
  For a subtotal of 8497 cents the fee is 64 cents.
- **The order total is split back down to the lines by largest remainder.** Each line gets
  a whole-cent share of the subtotal, so the line totals always add back up to the order
  total exactly (no drift); ties are broken by line position. Each line's fee is then
  what is left after its cost and markup, within 1 cent of its exact 0.75%, and the line
  fees add up to the order fee. For the 8497-cent order (Magnesium x2 + Vitamin D3 x1) the two lines get 45 and 19
  cents, which sum to 64. Line fees are stored and shown in the audit; the provider's
  order builder shows the order fee once, in the Order summary.
- **The invariant that must always hold:** for every order and every line,
  `cogs + fee + margin = total`, and `margin >= 0`. A line whose margin after its fee
  would go negative is rejected with `MARGIN_NEGATIVE` before anything is saved. The
  provider never unknowingly pays to sell (and a markup-priced line can never reach that
  floor - see the next point).
- **The provider types a dollar markup per unit; the server derives the price (ADR-028).**
  The patient pays COGS + markup + the 0.75% fee, and the order is rounded ONCE:
  `need = sum(qty x (cogs + markup))`, `subtotal = ceil(need * 10000 / (10000 - 75))`.
  Because the subtotal and the fee are both rounded up, `subtotal - need = fee` exactly:
  nothing is left over as rounding, and the provider nets exactly qty x markup on every
  line (a $0 markup nets exactly $0.00). A line whose total does not divide evenly by its
  quantity shows an average unit price ("avg"); the line total is what is charged. The
  line total, line fee and markup are all stored on the line; the markup is what the
  provider and the order audit see.
- **Snapshots, not live recomputation.** A draft re-derives its prices from the current
  COGS + markup. When an order is sent, the unit COGS is snapshotted and the price is
  re-derived from it and stored on the lines. A paid order is immutable. If catalog costs change later,
  the order's history does not move. Corrections are new ledger entries, never edits.

All of this split math lives in one place, `packages/money`, as pure integer functions
with example tests and 10k-run property tests. No other module computes a fee, an
allocation, a margin, or a refund amount.

### The ledger

Payment and refund are recorded as append-only double-entry journals. There are four
accounts:

- `CASH_CLEARING` - money moving through Cerbo from the patient.
- `COGS_RECOVERY` - Cerbo recovering its cost of goods.
- `PROVIDER_PAYABLE` - what Cerbo owes the provider (their margin).
- `PLATFORM_FEE_REVENUE` - Cerbo's 0.75% fee.

Every journal is posted per line (so each cent traces to a SKU) and every journal sums to
zero. Payment posts `CASH +total, COGS -cogs, PAYABLE -margin, FEE -fee`. The ledger
tables reject UPDATE and DELETE at the database level (triggers), with one narrow exception
for purging synthetic demo rows. The payment status change, the ledger posting, and the
inventory change all happen in one database transaction with a row lock on the order, so
there is no double charge and no oversell under concurrent requests.

## Key decisions and trade-offs

The full decision log with options considered is `docs/DECISIONS.md`. The ones that shape
the product:

- **ADR-001 / 002 - Fee base and who bears it.** The platform fee is 0.75% of the
  patient-paid subtotal. Since ADR-028 the fee is built into the patient's unit price (cost +
  markup + fee), so the provider keeps their markup; in the ledger it is still carved out of
  the line total before the provider's margin. The patient never sees a fee line. This matches the owner's headline metric (GMV x 75 bps)
  and keeps the patient experience clean.
- **ADR-003 - Rounding and allocation.** Fee computed once per order, rounded up (as
  amended by ADR-028; the order total is also rounded once), and line amounts are handed
  out by largest remainder. Per-line rounding would drift by a cent or two; this
  guarantees line fees sum exactly to the order fee.
- **ADR-004 - Margin floor.** A line's margin after its allocated fee must be >= 0 (zero is
  allowed). This prevents a provider from unknowingly selling at a loss.
- **ADR-005 - Price is canonical.** *Superseded by ADR-028:* providers no longer enter a price
  or a margin percent; they enter a per-unit dollar markup and the server derives the price.
- **ADR-006 - Snapshot at send; paid orders immutable.** History never changes when catalog
  costs change. Corrections are new journals.
- **ADR-007 - Append-only double-entry ledger, posted per line, enforced by DB triggers.**
  Every cent is traceable to a SKU and an account.
- **ADR-008 - Idempotency and single transaction.** An idempotency key on pay, plus a single
  locked transaction, means no double charge and no oversell under concurrency.
- **ADR-009 - One inventory pool under Cerbo.** Cerbo holds the stock; restock is a Cerbo
  Admin, demo-only action, because a provider-side restock would change stock for every
  practice.
- **ADR-011 - Stock checked three times.** At add-to-cart (UX gate), reserved at send
  (7-day expiry), and rechecked at pay. Add-time checking alone would allow oversell while
  orders sit unpaid.
- **ADR-012 - Refunds return 100% to the patient; the platform fee is retained and charged
  to the provider.** On a refund the patient gets every cent back, `PLATFORM_FEE_REVENUE` is
  left untouched (Cerbo keeps its fee), and the provider is debited both the margin reversal
  and that retained fee - so a refunded order nets the provider to minus the fee. The provider
  genuinely eats the fee on a refund. This mirrors how card processors keep their fee on
  refunds, and it is the decision most likely to surprise a provider, so it must be disclosed
  in provider terms (also a business risk below).
- **ADR-013 - Refund before fulfillment restocks; after fulfillment it does not.** Returned
  ingestibles are generally not resellable, so a post-fulfillment refund writes off the COGS
  and Cerbo bears that loss (also a business risk below). Reason codes are recorded.
- **ADR-014 - Whole-order refunds only; late refunds post to the current period; closed
  statements are never rewritten.**
- **ADR-015 - Metrics are summed from per-order ledger cents, with the owner's margin formula
  used only as a per-order reconciliation check.** A single blended margin percent across orders
  with different margins misstates profit, so the report sums real cents and uses the formula to
  verify them.
- **ADR-017 - Recurring is a schedule that generates one child order per cycle.** Each cycle
  takes a fresh COGS snapshot and (since ADR-028) prices each line from that cost + the
  schedule's markup, so a cost rise passes through to the patient and the provider keeps the
  markup. If stock is short, the margin would go negative (only possible for legacy lines priced
  before ADR-028), or the schedule is not authorized, the cycle is parked `on_hold` with a
  reason rather than silently absorbing the problem.
- **ADR-018 - Migration off marketplaces is measured against a CSV-imported baseline.** Migration
  percent is in-house GMV divided by the baseline monthly average. The real baseline source is
  still to be defined (a business risk below).
- **ADR-023 - Refunded patients are told to keep or safely dispose of the product; no returns
  are accepted.** Returned ingestibles are not resellable anyway (ADR-013), so accepting
  returns would pay return shipping for stock that is written off regardless, and telling the
  patient nothing would risk unnecessary returns. *Superseded in part by ADR-027.*
- **ADR-027 - Patients can request a refund for unopened products within 30 days of payment.**
  The patient confirms "unopened" (required), and the server enforces the 30-day window. The
  provider decides through a review link (`/refund-review/:token`, like a pay link but only
  for the owning provider). Accept refunds immediately through the standard refund. Shipped
  returns are always written off; unshipped orders restock (ADR-013). Return shipping is out
  of scope.
- **ADR-028 - Providers price with a per-unit dollar markup.** Each order line and schedule
  line carries `markupCents` ($0 to $1,000); the patient pays COGS + markup + fee. A dollar
  amount is what providers think in, the fee never eats into it, and a cost rise passes through
  to the patient instead of putting a recurring cycle on hold. Cerbo Admin no longer sets a list
  price or sees a margin percent; it sees the provider's markup in the order audit ("Provider
  (markup)" column), in Operations (markup per unit on each line) and in Metrics ("Provider
  markup (settled)"). Supersedes ADR-005, ADR-025 and the price clause of ADR-024.

## What is stubbed

This slice deliberately stubs every external integration behind an interface, so a real
integration could replace it without touching business logic (`apps/api/src/seams/`).

The five seams:

- **PaymentGateway** - `charge` / `refund` return a fake `stub_ch_<uuid>` reference. An
  amount of exactly 1313 cents forces a decline, which is how the demo shows the declined
  path. A real Stripe-style gateway would create a PaymentIntent and confirm by webhook
  through the same posting function.
- **FulfillmentService** - `markFulfilled` just sets `fulfilled_at`. A real 3PL or shipping
  API would replace it.
- **Notifier** - `sendPayLink` logs the patient pay link to the console; the provider UI
  shows a copyable link instead of sending an email or SMS.
- **PayoutService** - not called in this slice; provider payouts are a stub seam only.
- **Clock** - system time, except the demo data generator can inject past dates. Lets the
  reservation-expiry path be tested deterministically.

Other stubs:

- **Auth.** There is no real authentication. The role switcher sets an `X-Demo-User` header
  and middleware loads the actor and role. Patient pay pages are reached by an unguessable
  24-byte token in the URL, not a header. Every route still enforces role and ownership
  (a resource the actor does not own returns 404, not 403, so existence is not leaked).

Only one route still returns `501 NOT_IMPLEMENTED` on `main`:

- `POST /api/admin/jobs/run-due-schedules` - the admin console's on-demand "run every due
  recurring cycle now" button. The recurring engine behind it (`runDueSchedules`) is merged and
  works; this one admin HTTP trigger was simply never wired to it. Recurring cycles still run two
  ways that are wired: the provider action `POST /api/schedules/:id/run`, and the per-schedule
  run exercised by EVAL-11. The sibling job endpoint `POST /api/admin/jobs/expire-reservations`
  is wired.

Everything else is implemented and merged: order build and send, patient pay, payment and
ledger posting, audit, refunds and fulfillment, the provider sales dashboard and payable
reports with month close, recurring schedules, Cerbo Admin metrics and the migration report,
CSV baseline import, the guarded demo reset, and admin inventory restock.

## Tier 3: cut, then reinstated

The owner's rule (ADR-021) was to build in tier order and stop starting Tier 3 work if time
ran short, so the three Tier 3 tasks - recurring orders, Cerbo Admin metrics and demo data,
and Cerbo Admin inventory and operations - were cut partway through. The build finished the
core and Tier 2 ahead of schedule, so Tier 3 was reinstated and completed. All three are now
merged, and the eval suite covers them. Nothing in the plan is cut. That is the honest story,
and it is a better one than the earlier draft told.

## What the slice does beyond the core flow

These capabilities are implemented and merged, and each is covered by at least one eval
(see `tests/e2e/RESULTS.md`):

- **Recurring orders (FR-12, ADR-017, ADR-028).** A provider creates a schedule for a patient
  with lines (product, quantity, per-unit markup) and an interval. Each cycle creates a child
  order (`kind = recurring_cycle`) with a fresh COGS snapshot and a price of that cost + the
  markup + fee (the patient's authorization says the amount can change if costs change), reusing the same payment and posting path as a
  one-off order, so every cycle is a normal auditable order. If stock is short, the margin would
  go negative (legacy pre-markup lines only), or the patient has not authorized the schedule, the cycle is parked `on_hold`
  with a reason instead of silently charging or absorbing a loss (EVAL-11 to 11d).
- **Cerbo Admin metrics with a synthetic toggle (FR-13, ADR-015).** GMV, refunded GMV, settled
  GMV, platform fee revenue, sunk fees, provider net margin, provider markup (total and average
  per unit, ADR-028), and the migration view, all summed from ledger cents. Each figure carries the per-order reconciliation check, and an
  `includeSynthetic` toggle ("Include synthetic demo data", default off) decides whether demo
  rows are counted (EVAL-09, 13). With a multi-month range ("Last 3 months" / "Last 6 months")
  the migration card shows "Migration by month" - the leading indicator - plus an "Average
  monthly migration" headline and a per-provider trend.
- **Provider dashboard and payables.** The provider dashboard counts each sale in the month it
  was paid and has an "Include demo data" switch (default off, with a "Demo data included"
  banner when on). Provider payables are always "Real orders only": demo data never enters
  money Cerbo actually owes.
- **Evidence page (Cerbo Admin).** Live integrity checks (balanced journals, per-order
  invariants, stock consistency, append-only guards, reconciliation), unit economics against an
  adjustable card-processing estimate (default 2.9% + 30c) with the break-even platform fee,
  and refund exposure by reason.
- **CSV baseline import and the migration percentage (FR-14, ADR-018).** A Cerbo Admin uploads
  historical marketplace volume as CSV; rows are validated one by one and bad rows are reported
  rather than inserted. Migration percent is then in-house GMV against the baseline monthly
  average.
- **Guarded demo reset.** The demo data tools generate synthetic baseline and migration activity
  through the real split and posting code (backdated via the `Clock` seam, flagged
  `is_synthetic`, never touching inventory). "Reset demo story" purges synthetic data and
  regenerates the same fixed-seed story (6-month baseline + 3-month ramp) every time;
  "Regenerate baseline" replaces the synthetic baseline, while "Generate migration activity"
  adds orders on top of what is there. The reset purges only `is_synthetic` rows
  through the one narrow append-only exception. Real ledger rows are untouched, and
  `payable_statements` are never deletable even with the purge flag set (EVAL-13, EVAL-15, RT-14).
- **Admin inventory restock, labeled demo only (FR-15, ADR-009).** Cerbo Admin can raise a SKU's
  on-hand stock, recorded as an inventory movement with the actor. Providers get 403. The control
  carries a demo badge because real stock would come from procurement.
- **Patient My Orders view.** A patient has a page listing their orders, not just the single
  pay link.
- **Patient refund requests with a provider review link (ADR-026, ADR-027).** From My Orders a
  patient requests a refund for unopened products within 30 days of payment. The provider
  accepts (instant refund) or declines with a note, from the order audit or the review link.
- **Provider-recoverable pay links.** The patient pay link can be recovered later from the
  provider's Orders list and the order audit view (both now render a copy control bound to the
  order's pay path), so a demo does not depend on copying the link at the moment the order is
  sent. The link is also reachable via the send response and the Notifier stub log.

### Beyond the brief: lab-informed suggestions (DEMO showcase)

The order builder shows a read-only, DEMO-labelled block, "Suggestions from <patient>'s latest
labs". It reads the patient's latest lab panel and lists each low marker with the catalog
product it relates to, the result, the range and the date. A product already on the order
is marked as such; an out-of-stock one says so. It is decision support for the provider only:
no buttons, nothing stored, never shown to the patient.

![Lab suggestions block on the order builder (DEMO)](docs/images/lab-suggestions-option-c.png)

The approved wireframe is in `docs/SPEC.md` (E-1).

This is a showcase of where Cerbo can go, not a delivered requirement (ADR-029, SPEC E-1). The
lab panels are simulated for the two seeded patients and the rules are a small table in
`apps/web/src/demo/labSuggestions.ts`. A production version would move panels and rules
server-side behind provider-scoped access (lab results are protected health information),
source them from a lab feed (HL7 v2 / FHIR Observation), have the rules reviewed clinically,
and log who viewed them. The point it makes: an ordering platform that already knows the
patient, the catalog and the provider's margin can turn lab results into relevant,
explainable suggestions at the moment the order is built.

### Still out of scope by design

From `docs/SPEC.md` "Out of scope"; none of these is a cut, they were never in scope:

- **Partial (line-level) refunds** - the ledger supports them, but only whole-order refunds are
  wired. Next: a line-selection UI and a partial posting path.
- **Refund policy beyond ADR-027** - patient requests enforce "unopened" and a 30-day window;
  provider and admin direct refunds record a reason code only. Return shipping logistics are
  out of scope.
- **A real job scheduler** - the admin "run jobs" endpoints stand in for cron.
- **A real baseline source** - CSV import is the interim mechanism; the real source for
  historical marketplace volume is undefined.
- **A card-processing cost model** - processing fees are not charged or priced in this slice;
  the Evidence page only estimates them (adjustable rate) to show the break-even fee (see risks).
- No real payments, auth, email, shipping, or payouts; no tax, shipping cost, compliance,
  multi-currency, or multi-location stock.

## Business risks surfaced

From the bottom of `docs/DECISIONS.md`:

- **Card processing cost vs the 0.75% fee.** Real card processing typically costs well above
  0.75%. If Cerbo absorbs processing fees, each order can lose money. The pricing model has
  to account for this; it is not solved in this slice (ADR assumption A-3), but the Evidence
  page quantifies it: Cerbo's net per order at an adjustable processing estimate and the
  break-even platform fee.
- **Post-fulfillment refunds cost Cerbo the full COGS** while the provider only loses the
  fee (ADR-013). ADR-027 limits patient requests to unopened products within 30 days, and
  reason codes are recorded so the exposure is measurable (Evidence page).
- **Migration measurement depends on a trustworthy baseline.** The migration-off-marketplaces
  metric is only as good as the baseline GMV it is measured against, and the real source for
  that baseline is not yet defined (ADR-018).

## How AI was used

The full log, including where AI misled the team and how it was caught, is `docs/AI_LOG.md`.
This honesty is a required part of the deliverable, so it is summarized here rather than
sanitized.

Tools: Claude (a claude.ai Project) did the planning - PRD intake, gap analysis, decisions,
and execution tracking. Agent Orchestrator (AO) supervised worker sessions and tracked PRs
and CI. AO workers (the implementation agents) wrote the code, tests, and PRs.

Where it worked well: the Phase 1 gap analysis surfaced real holes in the PRD before any code
was written - the fee base, fee bearer, and rounding were undefined (became ADR-001 to 003);
add-to-cart stock checking alone allowed oversell (became the reservation model, ADR-011);
and the owner's single blended margin formula misstated profit when margins vary (became
per-order reconciliation, ADR-015).

Where it misled, and how it was caught:

- **Wrong CI provider.** The planning context pack specified GitHub Actions for a GitLab-hosted
  remote, so no pipeline could run. The worker and orchestrator both flagged it; a GitLab CI
  file was added.
- **A comment reddened the build.** The AI-01 guardrail greps for the literal token `toFixed`;
  a source comment in `packages/money` that named the forbidden token matched the grep and
  turned `main` red, blocking every downstream pipeline. The comment was reworded; the grep was
  left comment-blind on purpose so it cannot be weakened. (It was later narrowed to match call
  syntax such as `.toFixed(`, which still catches real use but not a comment naming the token.)
- **A worker merged before a human gate.** The shared GitLab token let a worker merge money
  code to `main` before the owner performed the G1 review. The orchestrator issued a hard
  no-merge directive; merge authority is now the orchestrator and owner only.
- **A documented deploy path was impossible.** `docs/DEPLOY.md` originally described adding a
  Railway service from a GitHub repo, but this project is on self-hosted GitLab and Railway's
  native integration is GitHub-only. The worker verified against Railway's docs and proposed
  alternatives; the owner approved deploying via a GitLab CI job running `railway up`.
- **Two false-green deploys.** The runtime image first copied only one workspace package, so
  when `@cerbo/money` became a runtime dependency the live site returned 502 even though CI was
  green. Separately, `railway up` reports success as soon as the build is queued, so a
  crash-looping deploy passed CI twice - once under a plausible-sounding `env -u CI` fix that
  was reasoned from docs but never verified at runtime. Both were caught by checking the live
  URL independently; the fix is copying all workspace packages and polling the real
  `/api/health` endpoint as the deploy gate.
- **A planning gap, not a bug.** `docs/ARCHITECTURE.md` specified `GET /api/patients` but no
  task owned it, so the provider UI had no way to get patient IDs. The UI worker escalated
  instead of fabricating data; the endpoint was assigned to T3.

The recurring lesson across the deploy issues: a green pipeline is not proof a system works.
Several failures passed CI and were only caught by independently exercising the live system.

## Build status

As of 2026-10-08 (tag `submission-2026-10-08`), every task in the plan is merged to `main`: T0 (scaffold, CI, seams, auth
stub), T1 (`packages/money`, gate G1), T2 (schema, migrations, DB protections, seed, gate G2),
T3 (order lifecycle, inventory, `GET /api/patients`), T4 (patient payment, per-line ledger
posting, audit, gate G3), T5 (refunds and fulfillment, gate G4), T6 (provider UI), T7 (patient
pay page and recurring authorize UI), T8 (provider dashboard and payable reports), T9 (recurring
orders), T10 (Cerbo Admin metrics, baseline import, demo data), T11 (Cerbo Admin inventory and
operations), T12 (Railway deploy), T13 (end-to-end eval and red-team suite), and
`docs/DIAGRAMS.md`.

After the plan, the owner made these changes, each merged through CI and deployed: per-unit
dollar markup pricing with the 0.75% fee rounded up once per order (ADR-028; the margin-percent
model, admin list price and profit simulator were removed), the migration trend and Reset demo
story on the Metrics page, the provider dashboard by payment date with an "Include demo data"
switch, past-dated seed orders, and the DEMO lab-suggestions block (ADR-029). The UI follow-up
(styling, DEMO badges, pay-link copy control, My Orders) is merged, and the owner reviewed the
screens during these final iterations.

The `main` pipeline for the submission commit (typecheck, lint, build, unit and API tests, then
the e2e suite against real Postgres, then the Railway deploy with a health check) passed on
2026-10-08: `packages/money` 40 tests, `apps/api` 210, `apps/web` 122, and the e2e suite 43. The
setup and run commands in this README were verified on a clean checkout on 2026-10-06, and
`scripts/local-check.ps1` reruns the same checks locally before every push.

### Eval and red-team results (CI-verified)

These counts are from the `e2e` CI job against real Postgres, not a local run. The full
id-by-id table is `tests/e2e/RESULTS.md`; read it rather than trusting this summary.

**Totals: PASS 43, FAIL 0, PENDING 0, CUT 0 - every EVAL and RT id in the specification is
covered.**

The passing set spans the money core, inventory and reservations, payment and ledger,
refunds, provider reports, recurring cycles including the `on_hold` paths, Cerbo Admin metrics
with the reconciliation check, synthetic demo data and the guarded reset, and the full
red-team suite (IDOR, token brute force, client-supplied amounts, parallel pay and refund,
concurrent oversell, injection, ledger-tamper, and demo-in-production). There are no cut or
pending ids.

## User interface and the demo-badge convention

`AGENTS.md` section 10 says "basic usable layout only, no styling work". The owner approved an
explicit exception for this submission: a styling pass was applied so the app reads as a
finished piece rather than a wireframe. This is an owner-approved deviation from the no-styling
guardrail, recorded here so it is not mistaken for scope creep.

The styling pass comes with one honest convention. Every control that exists only to make the
slice demonstrable carries a violet **DEMO** badge with a tooltip saying what the real system
would do instead. The badge (`apps/web/src/components/DemoBadge.vue`, violet on purpose so it is
never confused with a data state) marks, among others:

- the role switcher, which stands in for real authentication,
- the pay-link copy control, which stands in for an email or SMS to the patient,
- the admin run-job buttons, which stand in for a real scheduler,
- admin inventory restock, which stands in for procurement,
- the demo data tools, which generate and reset synthetic data.

The point of the convention is that a reviewer can tell a demo affordance from production design
at a glance, so no demo-only control is misread as a design flaw.

Scope note: the styling pass, the DEMO badges on the admin views, the pay-link copy control, and
the My Orders list rendering real data have all merged (the Orders list and the order audit view
now render a pay-link copy control, and My Orders fetches `GET /api/patient/orders`). The owner
reviewed the screens during the final iterations (2026-10-07 to 2026-10-08).

## Limitations

Known limits of this submission, beyond the stubs and the out-of-scope list above:

- **One environment.** Railway runs production only, with `DEMO_MODE=true` so the demo tools
  work. There is no staging; merging to `main` deploys. Real use would split staging and
  production and turn demo mode off.
- **No scheduler.** Recurring cycles run when the provider clicks "Run cycle now", and
  reservation expiry runs from an admin button. `POST /api/admin/jobs/run-due-schedules` is
  registered but returns 501: the sweep function exists and nothing calls it yet.
- **Whole-order refunds only.** The ledger and the stored per-line fees support line-level
  refunds; the UI and posting path for them are not built.
- **Demo-grade guards on a few admin tools.** Restock is not gated by demo mode (it stands in for
  procurement), and the payables API accepts the `includeSynthetic` flag even though the
  Payables page always shows real orders only.
- **CI runs on the owner's laptop.** The GitLab runner is a Docker container on one machine, so
  a sleeping laptop stalls a pipeline (the job is retried, not failed).
- **Simulated lab panels.** The lab-suggestions block (ADR-029) uses hard-coded panels for the
  two seeded patients; it is a showcase, not clinical decision support.
- **Metrics on demo volumes.** The migration indicator and fee break-even are computed correctly
  but on synthetic data; the baseline comes from a CSV import, not a real marketplace feed.

## Repository map

- `packages/money` - pure integer split math (fee, allocation, margin, refund, pricing).
- `packages/contracts` - shared request/response types.
- `apps/api` - Express API, Knex, Postgres, auth stub, seams, jobs.
- `apps/web` - Vue 3 SPA with the role switcher (`src/demo/` holds the ADR-029 lab showcase).
- `tests/e2e` - golden scenario and red-team evals.
- `docs/` - the context pack: SPEC, ARCHITECTURE, DECISIONS, METRICS, EVALS, RED_TEAM,
  DEPLOY, DIAGRAMS, AI_LOG, TRACKER, and DEMO_SCRIPT.

## Demo walkthrough

A step-by-step walkthrough by role, with exact seed figures and a mid-demo recovery plan, is
in `docs/DEMO_SCRIPT.md`.
