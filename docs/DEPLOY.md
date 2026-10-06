# DEPLOY.md - Railway deployment

Verify each step against Railway's current dashboard and docs; the names below reflect common Railway usage and may differ slightly.

> T12 status (2026-10-05): the image is built and verified locally against Postgres (see "Verified locally" below). The live Railway deploy is blocked on owner-provided credentials (see "Credentials needed from the owner"). The deploy itself is human gate G5.

## Topology
- One Railway service built from the repo `Dockerfile` (API serves the built Vue app)
- One Railway Postgres database

## Dockerfile shape
1. Stage `build`: `COPY . .` then `npm ci`, then `npm run build --workspaces` which builds `packages/*`, `apps/web` (Vite), and `apps/api` (tsc), then `npm prune --omit=dev`.
2. Stage `runtime`: Node 20 slim, copy built artifacts and production dependencies, `CMD ["node", "apps/api/dist/server.js"]`.
3. `server.ts` on boot: run Knex migrations to latest, run seed if the products table is empty, start listening on `process.env.PORT`.

### T12 corrections to the shape above (what was actually built)
- The original build stage copied only a hand-listed set of `package.json` files before `npm ci`. That silently breaks the moment a new workspace (for example `packages/money`, in flight) is added without updating the list. It was changed to `COPY . .` then `npm ci` so the build tracks the real workspace set. A `.dockerignore` keeps `node_modules`/`dist`/`.git` out of the build context so a dirty local tree cannot poison the image.
- `tsc` only emits `.ts` files, so the empty `src/db/migrations` and `src/db/seeds` directories (they hold only a `.gitkeep`) are absent from `dist`. Knex `migrate.latest()` then throws `ENOENT` scanning `dist/db/migrations` on boot. The runtime stage now runs `mkdir -p apps/api/dist/db/migrations apps/api/dist/db/seeds`. Once T2 adds real `.ts` migrations/seeds, `tsc` populates these directories and the `mkdir -p` is a harmless no-op. T12 did not create any migrations (T2 owns them); "migrates cleanly with zero migrations" is the current expectation and it now holds.

## Environment variables
| Variable | Value |
|---|---|
| `DATABASE_URL` | Reference to the Railway Postgres connection string (Railway reference variable, typically `${{Postgres.DATABASE_URL}}`) |
| `PORT` | Provided by Railway |
| `NODE_ENV` | `production` |
| `DEMO_MODE` | `true` for the demo deployment (enables demo endpoints and restock) |
| `PGSSL` | Set if the connection requires SSL (internal Railway networking usually does not) |

## No railway.json (config-as-code is deprecated)
T12 intentionally ships no `railway.json`/`railway.toml`. Railway's Config as Code is deprecated: existing files keep working for legacy services only until 2026-12-01, and a newly created service may not read them. Since Railway auto-selects the Dockerfile builder whenever a `Dockerfile` is present, a config file would buy nothing here and would be dead within weeks. Set the builder (auto), health check path, and auto-deploy in the dashboard as in the Steps below. (Ref: Railway docs, Config as Code - https://docs.railway.com/config-as-code.)

## Steps
1. Create a Railway project, add Postgres.
2. Add a service from the repo. Railway auto-detects the `Dockerfile` as the builder (no config file needed). If the repo is on GitLab rather than GitHub, connect it via Railway's GitHub mirror or deploy from a connected GitLab integration / CLI; confirm the current dashboard options.
3. Set the variables in the table above. `DATABASE_URL` should reference the Postgres plugin (`${{Postgres.DATABASE_URL}}`). Leave `PGSSL` unset for Railway internal networking; set it to `true` only if the connection string requires SSL.
4. Set the health check path to `/api/health` in the service settings (Deploy section).
5. Enable auto-deploy on `main` (redeploys on merge to main).
6. After first deploy: open the URL, switch roles, confirm seed data.

## Verified locally (T12, 2026-10-05)
Proven with `docker build` + a Postgres container, no Railway account required:
- Image builds clean from the repo `Dockerfile`.
- Boot runs `migrate.latest()` with zero migrations and does not error (after the `mkdir -p` fix above).
- Seed-if-empty is correct: with no `products` table yet (T2 owns it), boot logs "products table not present yet; skipping seed" and continues. Once T2 lands the schema+seed, an empty table triggers the seed.
- `GET /api/health` returns `200 {"status":"ok","db":{"connected":true}}`; returns `503` when the DB is unreachable.
- The SPA is served at `/` (built `apps/web/dist`), and unknown `/api/*` routes return the standard 404 envelope.
- `process.env.PORT` is honored (verified the service binds to an injected `PORT`, e.g. 8080), which is how Railway assigns the listen port.

## Credentials needed from the owner (Phase 2, blocks the live deploy / G5)
The local work is done; the live deploy needs the owner to provide, at minimum:
1. A Railway account (or an invite to one) with a project created, plus a Railway Postgres added to it.
2. Either a `RAILWAY_TOKEN` (project or account token) for CLI/non-interactive deploy, or an interactive `railway login`.
3. A decision on repo connection for auto-deploy on `main`: the canonical remote is GitLab (`labs.gauntletai.com`), and Railway's native auto-deploy integration is GitHub-first; confirm whether to mirror to GitHub, use a GitLab integration, or deploy via the Railway CLI from CI.
No accounts will be created and no spend will be incurred without the owner.

## Rollback
Redeploy the previous successful deployment from the Railway dashboard. Migrations are additive only, so rolling back code does not require rolling back schema.
