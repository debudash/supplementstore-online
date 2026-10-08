# AGENTS.md - Rules for every worker

Before any task, read `docs/SPEC.md`, `docs/ARCHITECTURE.md`, and your task in `docs/TASKS.md`.
If these documents conflict with each other or with your task, STOP and report the conflict to the orchestrator. Do not pick one silently.

## 1. Stack
- Node 20 LTS, TypeScript (strict), npm workspaces
- `apps/api` - Express, Knex, Postgres 16, Vitest + supertest
- `apps/web` - Vue 3 + Vite + Vue Router, small fetch-based API client, no UI library required
- `packages/money` - pure TypeScript, zero runtime dependencies, Vitest + fast-check
- `packages/contracts` - shared request/response TypeScript types
- Docker Compose for local, GitHub Actions for CI, Railway for deploy (see `docs/DEPLOY.md`)

## 2. Commands (created by T0, must exist exactly)
```
npm install
docker compose up -d db
npm run db:migrate
npm run db:seed
npm run dev          # api + web
npm run lint
npm run typecheck
npm test             # unit + api tests
npm run test:e2e     # scenario evals from docs/EVALS.md
npm run build
```

## 3. Money rules (non-negotiable)
1. All money is integer cents (`number`, always `Number.isSafeInteger`). Never floats for money, never `toFixed`, never `Math.round` on dollar values, never parse "29.99" style strings into cents with float math.
2. All split math lives in `packages/money`. No other module computes fees, allocations, margins, or refund amounts. API and UI call these functions.
3. Order fee is computed once at order level, rounded up to the cent (ADR-028): `Math.floor((subtotalCents * feeBps + 9999) / 10000)` with `feeBps = 75` snapshotted on the order. Orders priced from markups are also rounded once at order level (`priceOrder`), so the provider nets exactly qty x markup.
4. Line fee allocation uses largest remainder, integer math only, ties broken by line `position` ascending.
5. Invariants, per order and per line: `cogs + fee + margin = total`, and `margin >= 0`.
6. The ledger is append-only. Never UPDATE or DELETE `journals` or `ledger_entries`. Corrections are new journals. The only exception is the demo purge of `is_synthetic = true` rows through `apps/api/src/admin/demo/reset.ts`.
7. Every journal sums to zero.
8. Payment status change, ledger posting, and inventory change happen in ONE database transaction with a row lock (`SELECT ... FOR UPDATE`) on the order.
9. The server computes every amount from database snapshots. Ignore any price or total sent by a client at payment time.
10. `pg` returns `bigint` as string. Use the shared parser in `apps/api/src/db/types.ts`, never a raw `Number()` without a safe-integer check.

## 4. Protected files
Do NOT modify, weaken, skip, or delete these unless your task explicitly says a human approved it:
- `packages/money/test/**`
- `apps/api/test/invariants/**`
- `tests/e2e/golden/**`
- Any migration that is already merged (add a new migration instead)
- `AGENTS.md`, `CLAUDE.md`, `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/METRICS.md`, `docs/EVALS.md`

If a protected test fails, fix the code. If you believe the test is wrong, stop and report why. Never change an expected value to make a test pass.

## 5. File ownership
Edit only the paths your task lists under "Owns" in `docs/TASKS.md`.
T0 creates the shared registries with every route pre-registered:
- `apps/api/src/app.ts` mounts every module router (stubs return 501 until implemented)
- `apps/web/src/router.ts` registers every view (placeholder components until implemented)

Later tasks replace only their own module or view files. If you need a change outside your ownership, stop and report to the orchestrator.

## 6. Seams (stubs)
External dependencies are reached only through interfaces in `apps/api/src/seams/`:
`PaymentGateway`, `FulfillmentService`, `Notifier`, `PayoutService`, `Clock`.
Stub implementations live beside the interfaces and are wired in `seams/index.ts`. No business module imports a stub directly.

## 7. Auth stub
- Header `X-Demo-User: <user id>`. Middleware loads `actor = { id, role: 'provider' | 'patient' | 'cerbo_admin', providerId?, practiceId?, patientId? }`.
- Every route declares allowed roles AND performs an ownership check. A resource the actor does not own returns 404 (not 403) so existence is not leaked.
- Patient payment pages use an unguessable token in the URL (`crypto.randomBytes(24).toString('base64url')`), not `X-Demo-User`.

## 8. Errors
Shape: `{ "error": { "code": "INSUFFICIENT_STOCK", "message": "...", "details": { } } }`. Codes and HTTP statuses are listed in `docs/ARCHITECTURE.md` section 9. Error messages never include COGS, margin, or fee data on patient routes.

## 9. Definition of done
- Acceptance criteria in the task are met, referenced by FR IDs and EVAL IDs
- Unit tests for logic and API tests for endpoints, including failure paths
- `npm run lint`, `npm run typecheck`, `npm test` pass locally and in CI
- No TODOs in money, ledger, payment, or refund code
- PR description includes: what changed, FR IDs, how it was tested, what is stubbed, any deviation from the docs
- If you or a reviewer caught and corrected an AI mistake, add an entry to `docs/AI_LOG.md`
- Never report a task done with CI red

## 10. Scope guardrails
- No real payment, auth, email, shipping, or payout integrations
- No tax, shipping cost, or compliance features
- Basic usable layout only, no styling work
- No new runtime dependencies beyond the stack above without stating why in the PR
- In docs and UI copy, use a single hyphen, never em dashes
