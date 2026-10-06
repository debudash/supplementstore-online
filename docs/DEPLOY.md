# DEPLOY.md - Railway deployment

Verify each step against Railway's current dashboard and docs; names may drift.

> T12 status (2026-10-06): image built and verified locally against Postgres (see "Verified locally"). Deploy path approved by the owner: **Path A - a GitLab CI job on `main` runs `railway up`** and Railway builds our `Dockerfile`. The live deploy is human gate G5 and is gated on the owner creating the Railway project + Postgres and providing a `RAILWAY_TOKEN` CI variable. Do not deploy, create accounts, or spend without the owner.

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
A minimal `railway.json` is shipped at the repo root. It pins the Dockerfile builder and, more usefully, sets `healthcheckPath` to `/api/health` so the health gate (FR-17) is enforced on every `railway up` without a manual dashboard step. Caveat: Railway's config-as-code is deprecated (files keep working until 2026-12-01); the demo window is well inside that, and the file is harmless if a given service ignores it - the dashboard health check setting is the fallback. Ref: https://docs.railway.com/config-as-code.

## Auth model (owner-provided)
- The **owner** creates the Railway project and adds Postgres (dashboard), then stores a **project-scoped** `RAILWAY_TOKEN` as a **masked, protected** GitLab CI/CD variable named `RAILWAY_TOKEN`.
- The worker does **not** receive an account-scoped `RAILWAY_API_TOKEN`, so `railway init` / `railway add` are out of scope - the project and Postgres must already exist before the CI job runs.

## Steps
1. Owner: create a Railway project and add Postgres.
2. Owner: set the service variables above. `DATABASE_URL` references the Postgres plugin (`${{Postgres.DATABASE_URL}}`). Leave `PGSSL` unset for internal networking.
3. Owner: confirm the health check path is `/api/health` (the shipped `railway.json` sets it; the dashboard Deploy setting is the fallback).
4. Owner: add a masked, protected CI/CD variable `RAILWAY_TOKEN` (project token) in the GitLab project settings.
5. CI: the deploy job on `main` runs `railway up` and Railway builds the `Dockerfile` (added to `.gitlab-ci.yml` by T0 to avoid two workers editing that file; see the T12 report for the drafted job).
6. After first deploy: open the URL, switch roles, confirm seed data (G5 demo script).

## Verified locally (T12, 2026-10-05)
Proven with `docker build` + a Postgres container, no Railway account required:
- Image builds clean from the repo `Dockerfile`.
- Boot runs `migrate.latest()` with zero migrations and does not error (after the `mkdir -p` fix above).
- Seed-if-empty is correct: with no `products` table yet (T2 owns it), boot logs "products table not present yet; skipping seed" and continues. Once T2 lands the schema+seed, an empty table triggers the seed.
- `GET /api/health` returns `200 {"status":"ok","db":{"connected":true}}`; returns `503` when the DB is unreachable.
- The SPA is served at `/` (built `apps/web/dist`), and unknown `/api/*` routes return the standard 404 envelope.
- `process.env.PORT` is honored (verified binding to an injected `PORT`, e.g. 8080), which is how Railway assigns the listen port.

**Re-verification still required before G5:** T2's migrations and seed are not yet merged (gate G2). The checks above used a zero-migration boot. Once T2 lands, re-run the image against real migrations + real seed and confirm the boot migrates, seeds a non-empty products table, and `GET /api/health` returns 200. Zero-migration boot is not the same test.

## Cost
Railway has no permanent free tier. New users get a one-time 5 USD trial credit. The Hobby plan is 5 USD/month and includes 5 USD of usage; a small always-on API + Postgres typically adds a few USD of usage on top. The owner approved Hobby plus small usage. The worker does not spend anything.

## Rollback
Redeploy the previous successful deployment from the Railway dashboard. Migrations are additive only, so rolling back code does not require rolling back schema.
