# DEPLOY.md - Railway deployment

Verify each step against Railway's current dashboard and docs; names may drift.

> T12 status (2026-10-06): image built and verified locally against Postgres, including strict `npm ci` on updated `main` (see "Verified locally"). Deploy path approved by the owner: **Path A - a GitLab CI job on `main` runs `railway up`** and Railway builds our `Dockerfile`. The deploy build is now proven reproducible, but the deploy is NOT live until the owner creates the Railway project + Postgres and adds the `RAILWAY_TOKEN` CI variable, and the real-migration boot re-verification is still OUTSTANDING pending T2 (gate G2). The live deploy is human gate G5. Do not deploy, create accounts, or spend without the owner.

## Topology
- One Railway service built from the repo `Dockerfile` (the API serves the built Vue SPA).
- One Railway Postgres database.

## Why not a GitHub-style repo connection (verified finding)
Railway's native Git source integration (deploy-on-push) supports **GitHub only**, via its GitHub App. It does **not** connect to gitlab.com or to a self-hosted GitLab remote. This repo lives on self-hosted GitLab (`labs.gauntletai.com`), so the common "add a service from the GitHub repo" step does not apply. (The "GitLab" entries in Railway's docs are about running GitLab CE *on* Railway, or pulling a prebuilt image from a container registry - not using a GitLab repo as a build source.) Ref: Railway docs, GitHub Autodeploys - https://docs.railway.com/guides/github-autodeploys.

Three paths were considered to get "redeploy on merge to main" (FR-17):
- **A (approved): GitLab CI runs `railway up`.** A job on `main` uses the Railway CLI with a project-scoped `RAILWAY_TOKEN`; Railway builds our `Dockerfile`. Everything stays on `labs.gauntletai.com` and reuses runner 287. No GitHub mirror, no registry.
- B: CI builds the image and pushes it to a registry (GitLab Container Registry is supported) that Railway pulls. More moving parts.
- C: Mirror the repo to GitHub and use Railway's native auto-deploy. Adds a mirror to maintain.

## Dockerfile shape
1. Stage `build`: `COPY . .` then `npm ci`, then `npm run build --workspaces` (builds `packages/*`, `apps/web` via Vite, `apps/api` via tsc), then `npm prune --omit=dev`.
2. Stage `runtime`: Node 20 slim, copy built artifacts + production dependencies, `CMD ["node", "apps/api/dist/server.js"]`.
3. `server.ts` on boot: run Knex migrations to latest, seed if the products table is empty, listen on `process.env.PORT`.

### Build/runtime details that must not regress
- The build stage copies the whole repo (`COPY . .`) then runs `npm ci`, rather than hand-listing each workspace `package.json`. The hand-listed form silently breaks the moment a new workspace (for example `packages/money`) is added without updating the list. A `.dockerignore` keeps `node_modules`/`dist`/`.git` out of the build context so a dirty local tree cannot poison the image.
- **`mkdir -p apps/api/dist/db/migrations apps/api/dist/db/seeds` in the runtime stage is required.** `tsc` emits no empty directories, so when `src/db/migrations` and `src/db/seeds` hold only a `.gitkeep` they are absent from `dist`, and Knex `migrate.latest()` throws `ENOENT` scanning `dist/db/migrations` on boot. The `mkdir -p` makes a zero-migration boot succeed; once T2's real `.ts` migrations/seeds land, `tsc` populates these directories and the `mkdir -p` is a harmless no-op. Do not remove it. T12 created no migrations - T2 owns them.

## Environment variables
| Variable | Value |
|---|---|
| `DATABASE_URL` | Reference to the Railway Postgres connection string (Railway reference variable, typically `${{Postgres.DATABASE_URL}}`) |
| `PORT` | Provided by Railway |
| `NODE_ENV` | `production` |
| `DEMO_MODE` | `true` for the demo deployment (enables demo endpoints and restock) |
| `PGSSL` | Set to `true` only if the connection requires SSL (internal Railway networking usually does not) |

`server.ts` reads only `PORT`, `DATABASE_URL` (via Knex), and `PGSSL` at boot. No other variables are needed to start.

## railway.json
A minimal `railway.json` is shipped at the repo root. It pins the Dockerfile builder and, more usefully, sets `healthcheckPath` to `/api/health` so the health gate (FR-17) is enforced on every `railway up` without a manual dashboard step. Caveat: Railway's config-as-code is deprecated (files keep working until 2026-12-01); the demo window is well inside that, and the file is harmless if a given service ignores it - the dashboard health check setting is the fallback. After 2026-12-01, if Railway stops reading `railway.json`, nothing breaks silently: the builder is still auto-detected from the presence of the `Dockerfile`, and the `healthcheckPath`, `healthcheckTimeout`, and restart policy simply move to the service's Deploy settings in the Railway dashboard (the file can then be deleted). Ref: https://docs.railway.com/config-as-code.

## Auth model (owner-provided)
- The **owner** creates the Railway project and adds Postgres (dashboard), then stores a **project-scoped** `RAILWAY_TOKEN` as a **masked, protected** GitLab CI/CD variable named `RAILWAY_TOKEN`.
- The worker does **not** receive an account-scoped `RAILWAY_API_TOKEN`, so `railway init` / `railway add` are out of scope - the project and Postgres must already exist before the CI job runs.

## Steps
1. Owner: create a Railway project and add Postgres.
2. Owner: set the service variables above. `DATABASE_URL` references the Postgres plugin (`${{Postgres.DATABASE_URL}}`). Leave `PGSSL` unset for internal networking.
3. Owner: confirm the health check path is `/api/health` (the shipped `railway.json` sets it; the dashboard Deploy setting is the fallback).
4. Owner: add a masked, protected CI/CD variable `RAILWAY_TOKEN` (project token) in the GitLab project settings.
5. CI: the `deploy-railway` job in `.gitlab-ci.yml` runs on `main` and executes `railway up`, which uploads the repo so Railway builds the `Dockerfile`. The job is created only when `$CI_COMMIT_BRANCH == "main"` and `$RAILWAY_TOKEN` exists, so main stays green until the owner adds the token; it has no `needs`, so a red guardrail or a red build-test blocks the deploy.
6. After first deploy: open the URL, switch roles, confirm seed data (G5 demo script).

## Verified locally
Proven with `docker build` + a Postgres container, no Railway account required.

Re-verified 2026-10-06 on updated `main` (after the root lockfile was synced with the `@cerbo/money` workspace):
- **Strict `npm ci` succeeds inside the image** ("added 420 packages, audited 425") - no `|| npm install` fallback, no "Missing: @cerbo/money". This is the evidence that the committed lockfile is genuinely in sync and the Railway build (which uses strict `npm ci`) will succeed. Before the lockfile fix, strict `npm ci` failed here, so the deploy was NOT actually armed.
- Boot runs `migrate.latest()` with zero migrations and does not error (the `mkdir -p` fix above).
- Seed-if-empty is correct: with no `products` table yet (T2 owns it), boot logs "products table not present yet; skipping seed" and continues.
- `GET /api/health` returns `200 {"status":"ok","db":{"connected":true}}`; returns `503` when the DB is unreachable.
- The SPA is served at `/` (built `apps/web/dist`); unknown `/api/*` routes return the standard 404 envelope.
- `process.env.PORT` is honored (verified binding to an injected `PORT`, e.g. 8080), which is how Railway assigns the listen port.

**OUTSTANDING - real-migration boot re-verification (hard prerequisite for G5):** every check above used a ZERO-migration boot. T2's migrations and seed are not yet merged (gate G2, awaiting the owner's `approved-protected-change` label). Once T2 lands, the image must be re-run against the real migrations + real seed to confirm the boot migrates, seeds a non-empty `products` table, and `GET /api/health` returns 200. Zero-migration boot is not the same test, and the deploy must not be called verified without it.

## Cost
Railway has no permanent free tier. New users get a one-time 5 USD trial credit. The Hobby plan is 5 USD/month and includes 5 USD of usage; a small always-on API + Postgres typically adds a few USD of usage on top. The owner approved Hobby plus small usage. The worker does not spend anything.

## Rollback
Redeploy the previous successful deployment from the Railway dashboard. Migrations are additive only, so rolling back code does not require rolling back schema.
