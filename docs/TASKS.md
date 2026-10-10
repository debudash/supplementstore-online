# TASKS.md - Work breakdown

Rules: one task = one worker = one PR. Respect "Owns". Build in wave order; tasks in the same wave are parallel-safe.
Gates G1 to G5 require human approval before merge. All other tasks may be default-approved if CI is green and the PR checklist is complete.
Size: S (under 1h agent time), M (1 to 3h), L (3h+).

> Note (2026-10-07): this is the original plan, kept as a record. Every task is merged. Some acceptance criteria were later superseded: T6's "price or margin % input per line" is now a per-unit dollar markup (ADR-028), CI runs on GitLab (`.gitlab-ci.yml`), not only `.github/workflows/ci.yml`, and T11's run-due-schedules button calls a route that still returns 501 (the recurring sweep exists but is not wired to it).

## Execution waves
| Wave | Tasks | Notes |
|---|---|---|
| 1 | T0, T1 | Parallel. T1 touches only packages/money |
| 2 | T2, T12 | Parallel after T0 |
| 3 | T3 | Critical path. Needs T1, T2 |
| 4 | T4, T6 | T6 can build against T3's endpoints |
| 5 | T5, T7, T8, T9, T11 | Parallel after T4 |
| 6 | T10, T13 | After T5 |
| 7 | T14 | Last |

Critical path: T0 -> T2 -> T3 -> T4 -> T5 -> T13 -> T14 (T1 must also land before T3).

---

### T0 - Scaffold, shared registries, CI (Tier 1, M)
- Goal: monorepo that builds, tests, and runs locally with every route and view pre-registered
- FR: FR-16 (shell), FR-17 (health)
- Owns: root config files, `.github/workflows/ci.yml`, `docker-compose.yml`, `Dockerfile`, `apps/api/src/{app.ts,server.ts,db/knex.ts,db/types.ts,auth/**,seams/**}`, `apps/web/src/{main.ts,App.vue,router.ts,api/**,components/RoleSwitcher.vue}`, placeholder views and 501 stub routers for every module in ARCHITECTURE section 8, `packages/contracts/package.json`
- Depends: none
- Acceptance: all commands in AGENTS.md section 2 exist and pass; `/api/health` returns 200; role switcher sets `X-Demo-User`; seam interfaces and stubs exist exactly per ARCHITECTURE section 7; CI runs lint, typecheck, unit, api tests against a Postgres service container; CI grep check for AI-01 and protected-path diff check for AI-03
- Tests: health endpoint test, auth middleware tests (unknown user 401, role guard 403)

### T1 - Money core package (Tier 1, M) - GATE G1
- Goal: all split math as pure functions
- FR: FR-2 AC1, FR-6 AC1 to AC3, FR-8 AC2 to AC3 amounts
- Owns: `packages/money/**`
- Depends: none (creates its own package.json; T0 registers `packages/*` workspace)
- Acceptance: functions per ARCHITECTURE section 4; EVAL-01 to EVAL-04b and EVAL-P1 pass as unit tests; inputs validated as safe positive integers
- Tests: example tests for every EVAL above, fast-check properties (10k runs)
- Gate G1: human reviews the TEST FILE (do the rules match DECISIONS ADR-001 to 005?), not the implementation

### T2 - Schema, migrations, protections, seed (Tier 1, M) - GATE G2
- Goal: full data model including Tier 2 and 3 tables, so later tasks never need schema changes for planned scope
- FR: all (data), FR-7 AC3
- Owns: `apps/api/src/db/migrations/**`, `apps/api/src/db/seeds/**`, `apps/api/test/invariants/db.*.test.ts`
- Depends: T0
- Acceptance: every table, check constraint, unique constraint, and trigger in ARCHITECTURE section 3; seed exactly as EVALS.md seed table; seed is idempotent; seed-if-empty helper exported for server boot
- Tests: constraint tests (reserved > on_hand rejected, unbalanced journal rejected at commit, UPDATE on ledger rejected, DELETE non-synthetic rejected, purge of synthetic allowed only with session flag)
- Gate G2: human reviews migrations for ledger tables and triggers

### T3 - Order lifecycle and inventory (Tier 1, L)
- Goal: draft, lines, quote, send with snapshot and reservation, cancel, expiry
- FR: FR-1, FR-2, FR-3, FR-4
- Owns: `apps/api/src/orders/**`, `apps/api/src/inventory/**`, `apps/api/src/jobs/expire.ts`, `packages/contracts/src/orders.ts`, `apps/api/test/orders/**`
- Depends: T1, T2
- Acceptance: endpoints per ARCHITECTURE section 8 (provider order routes except refund and audit); all split math via `packages/money`; stock check, reserve, release with movements; row locks on products; EVAL-04, EVAL-05, 05b, 05c, EVAL-14 pass at API level; RT-01, RT-05, RT-06, RT-07 covered
- Tests: API tests including concurrency test for RT-05

### T4 - Payment, ledger posting, audit (Tier 1, L) - GATE G3
- Goal: patient pay flow and the money record
- FR: FR-5, FR-6 AC4, FR-7 AC1
- Owns: `apps/api/src/payments/**`, `apps/api/src/ledger/**`, patient pay routes, `packages/contracts/src/{payments,audit}.ts`, `apps/api/test/payments/**`, `apps/api/test/invariants/ledger.*.test.ts`
- Depends: T3
- Acceptance: single-transaction pay per AGENTS money rule 8; idempotency per FR-5 AC2; decline path; per-line PAYMENT journal; audit endpoint with invariant block; patient whitelist serializer; EVAL-06 to 06d, EVAL-12 pass; RT-02, RT-03, RT-04, RT-10, RT-15 covered
- Gate G3: human reviews the posting function, the transaction boundary, and the ledger invariant tests

### T5 - Refunds and fulfillment stub (Tier 2, M) - GATE G4
- FR: FR-8, FR-9
- Owns: `apps/api/src/refunds/**`, `apps/api/src/fulfillment/**`, `packages/contracts/src/refunds.ts`, `apps/api/test/refunds/**`
- Depends: T4
- Acceptance: REFUND journal per ARCHITECTURE section 5; restock vs write-off; reason codes; EVAL-07, 07b, 08, 08b pass; RT-08 covered
- Gate G4: human reviews refund posting and EVAL-07 expectations

### T6 - Provider UI: order builder, orders list, audit view (Tier 1, M)
- FR: FR-1 to FR-4 UI, FR-7 AC2
- Owns: `apps/web/src/views/provider/{OrderBuilder,Orders,OrderAudit}.vue`, `apps/web/src/components/order/**`
- Depends: T3 (audit view completes after T4 merges)
- Acceptance: price or margin % input per line; live quote showing price, COGS, fee, net margin; INSUFFICIENT_STOCK alert text: "On-hand stock cannot meet this quantity (available: N). Wait for restock or reduce quantity."; MARGIN_NEGATIVE inline per line; send shows copyable patient link; audit view renders journals and invariant results
- Tests: component tests for quote rendering and error alerts (light)

### T7 - Patient pay page (Tier 1, S)
- FR: FR-5 UI, FR-12 AC2 UI
- Owns: `apps/web/src/views/patient/**`
- Depends: T4
- Acceptance: shows only whitelisted fields; pay button generates idempotency key once per page load; handles declined, expired, already paid; recurring authorize page

### T8 - Provider dashboard and payable reports (Tier 2, M)
- FR: FR-10, FR-11
- Owns: `apps/api/src/reports/**`, `apps/web/src/views/provider/{Dashboard,Payables}.vue`, `apps/web/src/views/admin/Payables.vue`, admin payables close route, `packages/contracts/src/reports.ts`, `apps/api/test/reports/**`
- Depends: T4 (refund rows appear once T5 merges; tests seed refunds via T5 service after merge)
- Acceptance: figures from ledger entries; monthly default; month close creates immutable statement; EVAL-09b, EVAL-10 pass

### T9 - Recurring orders (Tier 3, L)
- FR: FR-12
- Owns: `apps/api/src/recurring/**`, `apps/api/src/jobs/recurring.ts`, `apps/web/src/views/provider/Recurring.vue`, `packages/contracts/src/recurring.ts`, `apps/api/test/recurring/**`
- Depends: T4
- Acceptance: EVAL-11 to 11d pass; RT-13 covered; uses payments posting function (no duplicate posting code)

### T10 - Cerbo Admin metrics, baseline, demo data (Tier 3, L)
- FR: FR-13, FR-14
- Owns: `apps/api/src/admin/metrics/**`, `apps/api/src/admin/demo/**`, baseline import route, `apps/web/src/views/admin/{Metrics,DemoData}.vue`, `packages/contracts/src/admin.ts`, `apps/api/test/admin/**`
- Depends: T5 (needs refunds), T8 (reuse report queries where possible)
- Acceptance: every metric in METRICS.md with synthetic toggle; reconciliation line; CSV import with row-level validation; regenerate baseline; generate migration via real split and posting code with injected Clock, no inventory impact; reset purges only synthetic; EVAL-09, EVAL-13, EVAL-15 pass; RT-12, RT-14 covered

### T11 - Cerbo Admin inventory (demo) and operations console (Tier 2/3, S)
- FR: FR-9 UI, FR-15, admin refund
- Owns: `apps/api/src/admin/inventory/**`, admin fulfill and refund routes, jobs endpoints, `apps/web/src/views/admin/{Inventory,Operations}.vue`
- Depends: T4 (refund button live after T5)
- Acceptance: restock with movement and "Demo only" label; providers get 403 (RT-09); buttons for fulfill, refund, expire job, run-due-schedules

### T12 - Railway deploy pipeline (Tier 1, S)
- FR: FR-17
- Owns: `Dockerfile` (after T0 handoff), `railway.json` or `railway.toml` if used, `docs/DEPLOY.md` updates (allowed exception)
- Depends: T0
- Acceptance: deploys the T0 skeleton to Railway early; boot runs migrations and seed-if-empty; health check passes; redeploys on merge to main; env vars per DEPLOY.md

### T13 - E2E golden evals and red-team suite (Tier 1, M)
- Owns: `tests/e2e/**`
- Depends: T5 (extend as T9, T10 merge)
- Acceptance: every EVAL and RT-A case implemented against real Postgres; runs in CI as `npm run test:e2e`; reports which IDs pass

### T14 - Demo script and final write-up support (Tier 1, S)
- Owns: `README.md`, `docs/DEMO_SCRIPT.md`
- Depends: all merged
- Acceptance: setup, run, deploy URL, demo walkthrough by role; fill README sections from DECISIONS.md, TRACKER.md, AI_LOG.md; list every stub and every cut

## Human gates
| Gate | Task | What to review | Time |
|---|---|---|---|
| G1 | T1 | Money test file: rules match ADR-001 to 005, EVAL values correct | 20 min |
| G2 | T2 | Ledger tables, triggers, constraints | 15 min |
| G3 | T4 | Posting function, transaction boundary, idempotency | 30 min |
| G4 | T5 | Refund posting, EVAL-07 | 15 min |
| G5 | Deploy | Click through DEMO_SCRIPT on Railway | 20 min |
