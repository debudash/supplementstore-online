# Cerbo In-House Supplement Ordering - Vertical Slice

A provider assembles a supplement order for a patient inside the EHR, the patient
pays Cerbo directly through a link, and every cent is split and recorded in an
append-only double-entry ledger: cost of goods to Cerbo, margin to the provider,
and a 0.75% platform fee to Cerbo.

This repository is a vertical slice, not a product. It builds the core money flow
end to end (order, payment, ledger, audit, refund) and leaves everything outside
that flow as a clearly marked stub or a documented cut.

Live demo: https://cerbo-api-production.up.railway.app
Health endpoint: https://cerbo-api-production.up.railway.app/api/health

> Status note (2026-10-06): every Tier 1 and Tier 2 task is merged. Three Tier 3
> tasks were cut for time (recurring orders, admin metrics/demo data, admin
> inventory/operations); they are listed honestly under "What was deliberately
> cut". The eval and red-team pass counts below come from the CI-run suite, not a
> local claim. See "Build status" at the bottom.

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
npm test                    # unit tests (packages/money) + api tests (apps/api)
npm run test:e2e            # scenario evals in tests/e2e against Postgres
npm run build               # build packages, apps/web (Vite), apps/api (tsc)
```

Copy `.env.example` to `.env` for local overrides. The defaults match
`docker-compose.yml` (`DATABASE_URL=postgres://postgres:postgres@localhost:5432/cerbo`,
`PORT=3000`, `DEMO_MODE=true`).

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
- **AI-01 float-money guard** - a grep that fails the build if forbidden float-money tokens
  (`toFixed`, `parseFloat`) appear in the money, ledger, payment, refund, or report code.
- **AI-03 protected-path guard** - diffs the protected docs and test paths against `main`; any
  change requires explicit human approval, so a worker cannot quietly weaken a test or a spec.
- **The end-to-end eval and red-team suite** runs as its own `e2e` job against real Postgres,
  with no `allow_failure`. A failing EVAL or RT case reds the pipeline and blocks the deploy.
- **A post-deploy health poll** against the live `/api/health` URL fails the deploy job if the
  site does not return 200, which catches a crash-looping release that `railway up` alone
  would report as green.

## The money model, in plain language

Everything about money is designed so a non-engineer can follow it and so no cent is
ever lost to rounding.

- **Integer cents only.** Every amount is an integer number of cents. No floats, no
  `toFixed`, no decimal strings parsed with float math. `$29.99` is stored as `2999`.
- **One fee per order, computed once.** The platform fee is 0.75% (75 basis points) of
  the order subtotal, rounded half-up, computed a single time at the order level:
  `fee = floor((subtotal * 75 + 5000) / 10000)`. For a subtotal of 8497 cents the fee is
  64 cents.
- **The fee is split back down to the lines by largest remainder.** Each line gets a
  whole-cent share of the order fee, and the line shares always add back up to the order
  fee exactly (no drift). Ties are broken by line position. For the worked example above
  the two lines get 45 and 19 cents, which sum to 64.
- **The invariant that must always hold:** for every order and every line,
  `cogs + fee + margin = total`, and `margin >= 0`. A line whose margin after its fee
  would go negative is rejected with `MARGIN_NEGATIVE` before anything is saved. The
  provider never unknowingly pays to sell.
- **Price is the stored truth.** The provider can type a price or a margin percent; margin
  percent just derives a price (`price = ceil(cogs * 10000 / (10000 - marginBps))`). Only
  the price is stored.
- **Snapshots, not live recomputation.** When an order is sent, the unit COGS and price
  are snapshotted onto the lines. A paid order is immutable. If catalog costs change later,
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
  patient-paid subtotal, and the provider bears it (it comes out of their margin). The
  patient never sees a fee line. This matches the owner's headline metric (GMV x 75 bps)
  and keeps the patient experience clean.
- **ADR-003 - Rounding and allocation.** Fee computed once per order, half-up, then
  allocated to lines by largest remainder. Per-line rounding would drift by a cent or two;
  this guarantees line fees sum exactly to the order fee.
- **ADR-004 - Margin floor.** A line's margin after its allocated fee must be >= 0 (zero is
  allowed). This prevents a provider from unknowingly selling at a loss.
- **ADR-005 - Price is canonical.** Margin percent is an input mode that derives the price;
  only the price is stored, so there is one source of truth.
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
- **ADR-023 - Refunded patients are told to keep or safely dispose of the product; no returns
  are accepted.** Returned ingestibles are not resellable anyway (ADR-013), so accepting
  returns would pay return shipping for stock that is written off regardless, and telling the
  patient nothing would risk unnecessary returns.

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

Routes that still return `501 NOT_IMPLEMENTED` on `main`. Every one belongs to a task that
was cut (see "What was deliberately cut"); nothing on the core flow is stubbed:

- `GET /api/admin/metrics`, `POST /api/admin/demo/baseline/regenerate`,
  `POST /api/admin/demo/migration/generate`, `POST /api/admin/demo/reset`,
  `POST /api/admin/baseline/import` - T10 admin metrics and demo data. CUT.
- `GET /api/admin/inventory`, `POST /api/admin/inventory/:sku/restock` - T11 admin
  inventory. CUT.
- `POST /api/admin/jobs/expire-reservations`, `POST /api/admin/jobs/run-due-schedules` -
  T11 admin job endpoints. CUT. (The reservation-expiry logic itself runs: it is wired to the
  in-process 60s timer and exercised by EVAL-14; only the on-demand admin HTTP trigger is
  stubbed.)
- `GET/POST /api/schedules`, `POST /api/schedules/:id/(pause|resume|cancel|run)`,
  `GET/POST /api/pay/schedule/:token`, `.../authorize` - T9 recurring orders. CUT.

Everything on the core flow is implemented and merged: order build and send, patient pay
(page and routes, T7), payment and ledger posting, audit, refunds and fulfillment (T5), and
the provider sales dashboard and payable reports including month close (T8). The admin
fulfill, refund, and audit routes are also wired.

## What was deliberately cut, and what is next

These were cut for time against a one-day deadline, under the owner's rule to stop starting
Tier 3 work if time runs short (ADR-021). They are cuts, not failures, and are listed
honestly:

- **T9 - Recurring orders (FR-12).** A schedule that generates a child order each cycle with
  a fresh COGS snapshot and locked prices, a one-time patient authorization, and an on-hold
  path when stock or margin fails. To finish: the schedule and cycle services, the
  `run-due-schedules` job, the authorize page, and EVAL-11 to 11d. The schema tables already
  exist; the reason it is safe to cut is that the core one-off order path it would reuse is
  done.
- **T10 - Cerbo Admin metrics, baseline import, and demo data (FR-13, FR-14).** The GMV and
  migration dashboard, CSV baseline import, synthetic demo-data generation through the real
  posting code, and the synthetic-only reset. To finish: the metric queries in
  `docs/METRICS.md`, the CSV validator, the demo generator using the Clock seam, and
  EVAL-09, 13, 15. Cut because it is Tier 3 and sits on top of reports (T8).
- **T11 - Cerbo Admin inventory and operations console (FR-9 UI, FR-15, admin refund/fulfill
  buttons).** Demo restock with movement records, and buttons for fulfill, refund, and
  running the jobs. The fulfill, refund, and audit backend routes are already wired (T5/T4);
  what is cut is the admin UI and the demo-only restock endpoint (providers must get 403), plus
  the on-demand HTTP job triggers. To finish: the restock endpoint and the admin console views.

Also out of scope by design (`docs/SPEC.md` "Out of scope"), with what each would take next:

- **Partial (line-level) refunds** - the ledger already supports them; only whole-order
  refunds are wired. Next: a line-selection UI and a partial posting path.
- **Refund policy enforcement** - only reason codes are recorded; no rules are applied.
- **A real job scheduler** - demo endpoints stand in for cron; next is a real scheduler.
- **A real baseline source** - CSV import is the interim mechanism; the real source for
  historical marketplace volume is undefined.
- **A card-processing cost model** - processing fees are ignored in this slice (see risks).
- No real payments, auth, email, shipping, or payouts; no tax, shipping cost, compliance,
  multi-currency, or multi-location stock.

## Business risks surfaced

From the bottom of `docs/DECISIONS.md`:

- **Card processing cost vs the 0.75% fee.** Real card processing typically costs well above
  0.75%. If Cerbo absorbs processing fees, each order can lose money. The pricing model has
  to account for this; it is not solved in this slice (ADR assumption A-3).
- **Post-fulfillment refunds cost Cerbo the full COGS** while the provider only loses the
  fee (ADR-013). A refund policy would mitigate this; for now reason codes are recorded so
  the exposure is measurable.
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
  left comment-blind on purpose so it cannot be weakened.
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

As of 2026-10-06, merged to `main`: T0 (scaffold, CI, seams, auth stub), T1 (`packages/money`,
gate G1), T2 (schema, migrations, DB protections, seed, gate G2), T3 (order lifecycle,
inventory, `GET /api/patients`), T4 (patient payment, per-line ledger posting, audit, gate G3),
T5 (refunds and fulfillment, gate G4), T6 (provider UI), T7 (patient pay page and recurring
authorize UI), T8 (provider dashboard and payable reports), T12 (Railway deploy), T13 (end-to-end
eval and red-team suite), and `docs/DIAGRAMS.md`. The three cut tasks (T9, T10, T11) are listed
above.

The setup and run commands in this README were verified on a clean checkout on 2026-10-06:
`npm install`, `npm run db:migrate`, `npm run db:seed` (seeds exactly the 5-SKU catalog, 2
practices, 2 providers, 2 patients, 5 users), `npm run typecheck`, `npm run lint`, `npm run
build`, and `npm test` (101 api and unit tests plus 24 web tests) all passed. `docker compose up
-d db` is the documented way to start Postgres.

### Eval and red-team results (CI-verified)

These counts are from the `e2e` CI job against real Postgres, not a local run. The full
id-by-id table is `tests/e2e/RESULTS.md`; read it rather than trusting this summary.

**Totals: PASS 34, FAIL 0, PENDING 0, CUT 9.**

- **Passed (34):** money EVAL-01, 02, 03, 04, 04b, P1; inventory EVAL-05, 05b, 05c, 14;
  payment and ledger EVAL-06, 06b, 06c, 06d, 12; refunds EVAL-07, 07b, 08, 08b; reports
  EVAL-09b, 10; red-team RT-01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 15.
- **Cut (9), because the owning task was cut:** recurring EVAL-11, 11b, 11c, 11d and RT-13 (T9);
  admin metrics and demo EVAL-09, 13, 15 and RT-14 (T10). These cannot pass in this slice; they
  are reported as cut, not as failures.

Every money, inventory, payment, ledger, refund, privacy, and concurrency red-team case that is
in scope passes. The only non-passing ids are the ones whose feature was deliberately cut.

## Repository map

- `packages/money` - pure integer split math (fee, allocation, margin, refund, pricing).
- `packages/contracts` - shared request/response types.
- `apps/api` - Express API, Knex, Postgres, auth stub, seams, jobs.
- `apps/web` - Vue 3 SPA with the role switcher.
- `tests/e2e` - golden scenario and red-team evals.
- `docs/` - the context pack: SPEC, ARCHITECTURE, DECISIONS, METRICS, EVALS, RED_TEAM,
  DEPLOY, DIAGRAMS, AI_LOG, TRACKER, and DEMO_SCRIPT.

## Demo walkthrough

A step-by-step walkthrough by role, with exact seed figures and a mid-demo recovery plan, is
in `docs/DEMO_SCRIPT.md`.
