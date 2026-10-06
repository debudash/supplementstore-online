# DEPLOY.md - Railway deployment

Verify each step against Railway's current dashboard and docs; names may drift.

> T12 status (2026-10-06): the deploy path works end to end on real infrastructure. **Path A** (approved): a GitLab CI job on `main` runs `railway up`, Railway builds our `Dockerfile`, migrations + seed run on boot, and the app serves at a Railway-generated public URL. First live deploy succeeded, then a later deploy (T3's code) crash-looped on a runtime packaging bug (`@cerbo/money` missing from the image) - fixed by copying all workspace packages into the runtime stage, plus a CI fix so a crashed deploy now reds the pipeline instead of reporting a false green. The live deploy is human gate G5 (owner clicks through DEMO_SCRIPT on the live URL). Do not deploy, create accounts, or spend without the owner.

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
- **The runtime stage copies ALL workspace packages generically (`COPY --from=build /app/packages ./packages`), not a hand-listed subset.** `node_modules` holds an `@cerbo/<pkg>` symlink per workspace pointing at `/app/packages/<pkg>`, so every package the API `require`s at runtime must be present in the image. An earlier version copied only `packages/contracts`; when T3 made `@cerbo/money` a runtime dependency, the deployed image crashed at boot with `Error: Cannot find module '@cerbo/money'` (MODULE_NOT_FOUND) and the live site returned 502. Copying the whole `packages` tree (dist + package.json for each; dev `node_modules` already pruned, total ~300 KB) fixes it for every current and future package. Do not narrow this back to specific package names.

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

## Auth model: project token vs account token (gotcha)
Railway has two token types and the CLI reads them from **different env vars**:
- **Project token -> `RAILWAY_TOKEN`.** Scoped to one project + environment. Works for deployment and project actions: `railway up`, `railway status`, `railway add` (create a service), `railway variable`, `railway domain`. It does **not** work for account-level actions: `railway whoami`, `railway link`, and the GraphQL `me {}` query all return **Unauthorized/Not Authorized** with a project token. (During T12 the token we were given was project-scoped even though it was described as account-level; `RAILWAY_API_TOKEN` failed and `RAILWAY_TOKEN` worked. If `whoami` is Unauthorized, you have a project token - use `RAILWAY_TOKEN`.)
- **Account/team token -> `RAILWAY_API_TOKEN`.** Needed for account-level operations like `railway whoami`, `railway link`, and `railway init`.

For CI deploy, the CI job only needs the **project token** in `RAILWAY_TOKEN`. The owner stores it as a **masked, protected** GitLab CI/CD variable named `RAILWAY_TOKEN`. The project, Postgres, the app service, and its domain must be set up before the first deploy (steps below); a project token cannot create the project itself.

## Steps (real end-to-end sequence)
These are the actual steps that produced a working live deploy. 1-6 are one-time owner setup; 7 is the repeatable deploy.
1. **Create the project + Postgres.** In Railway, create a project (ours is `pleasing-magic`, environment `production`) and add a Postgres database. Postgres appears as a service named `Postgres`.
2. **Pre-create the APP service as an Empty Service.** `railway up` deploys INTO an existing service; it does not reliably create one in CI. On the project canvas click **New** (or Cmd/Ctrl+K -> "new service") -> **Empty Service**, and name it (ours is `cerbo-api`). Alternatively, with a project token: `RAILWAY_TOKEN=<tok> railway add --service cerbo-api --variables 'DATABASE_URL=${{Postgres.DATABASE_URL}}' --variables 'NODE_ENV=production' --variables 'DEMO_MODE=true'`.
3. **Set the variables ON THE APP SERVICE** (not on Postgres), per the table above:
   - `DATABASE_URL = ${{Postgres.DATABASE_URL}}` - a **reference**, not a literal. The prefix must match the Postgres service's actual name (ours is `Postgres`). You can confirm it is stored as a reference, not a pre-expanded literal, because a readback RESOLVES to a connection string rather than echoing the `${{...}}` text.
   - `NODE_ENV = production`, `DEMO_MODE = true`.
   - Do NOT set `PORT` (Railway injects it; the app reads `process.env.PORT`). Leave `PGSSL` unset - the internal Postgres connection needs no client SSL (verified against the `postgres-ssl:18` image: no SSL error on boot).
4. **Generate a public domain for the app service - this is a REQUIRED separate step.** A new service has NO public URL until you generate one, so even a healthy deploy is unreachable until you do this. In the dashboard: app service -> Settings -> Networking -> Generate Domain. By CLI: `RAILWAY_TOKEN=<tok> railway domain --service cerbo-api -e production --port 8080` (target the port the app listens on; Railway injects `PORT=8080`). This yields a `*.up.railway.app` URL (ours: `https://cerbo-api-production.up.railway.app`). Do NOT buy or attach a custom domain for the demo.
5. **Add the GitLab CI/CD variables:** `RAILWAY_TOKEN` (the **project** token; masked, protected), `RAILWAY_SERVICE` (the app service **NAME**, e.g. `cerbo-api`, not an ID; protected), and `RAILWAY_HEALTHCHECK_URL` (protected) set to the app's health endpoint, e.g. `https://cerbo-api-production.up.railway.app/api/health`. `RAILWAY_SERVICE` is required when the project has more than one service (ours has `Postgres` + `cerbo-api`) so `railway up` knows which to deploy to. `RAILWAY_HEALTHCHECK_URL` is the post-deploy health gate (step 7); if it is unset the deploy job fails loudly rather than skipping the gate. These are protected variables, so the deploy branch (`main`) must be a protected branch for them to be exposed to the job.
6. **(Optional) Health-check path.** The shipped `railway.json` sets `healthcheckPath=/api/health`; the dashboard Deploy setting is the fallback.
7. **Deploy.** The `deploy-railway` job in `.gitlab-ci.yml` runs on `main` and executes `railway up --service "$RAILWAY_SERVICE"`, uploading the repo so Railway builds the `Dockerfile`. The job is created only when `$CI_COMMIT_BRANCH == "main"` and `$RAILWAY_TOKEN` exists (main stays green before the token is set) and has no `needs` (a red guardrail or build-test blocks the deploy). `railway up` returns once the deploy is QUEUED, not when the app is healthy, so the job then **polls `RAILWAY_HEALTHCHECK_URL` until it returns HTTP 200** and fails the job (reds the pipeline) if it never does within ~5 min; it also fails loudly if that variable is unset. This poll - not `railway up` - is what makes a crashed or unhealthy deploy fail the pipeline. Set `RAILWAY_HEALTHCHECK_URL` to the app's health endpoint, e.g. `https://cerbo-api-production.up.railway.app/api/health`. After deploy: open the generated URL, switch roles, confirm seed data (G5 demo script).

## Verified locally
Proven with `docker build` + a Postgres container, no Railway account required.

Re-verified 2026-10-06 on updated `main` (after the root lockfile was synced with the `@cerbo/money` workspace):
- **Strict `npm ci` succeeds inside the image** ("added 420 packages, audited 425") - no `|| npm install` fallback, no "Missing: @cerbo/money". This is the evidence that the committed lockfile is genuinely in sync and the Railway build (which uses strict `npm ci`) will succeed. Before the lockfile fix, strict `npm ci` failed here, so the deploy was NOT actually armed.
- Boot runs `migrate.latest()` with zero migrations and does not error (the `mkdir -p` fix above).
- Seed-if-empty is correct: with no `products` table yet (T2 owns it), boot logs "products table not present yet; skipping seed" and continues.
- `GET /api/health` returns `200 {"status":"ok","db":{"connected":true}}`; returns `503` when the DB is unreachable.
- The SPA is served at `/` (built `apps/web/dist`); unknown `/api/*` routes return the standard 404 envelope.
- `process.env.PORT` is honored (verified binding to an injected `PORT`, e.g. 8080), which is how Railway assigns the listen port.

### Real-migration boot - VERIFIED 2026-10-06 (after T2 merged, gate G2, merge e2cce72)
The image was rebuilt on `main` with T2's real schema + seed present and booted against Postgres. Actual results (not expectations):
- `migrate.latest()` applied all 5 T2 migrations cleanly, loaded as compiled `.js` (confirming the production contract below): `20261005120001_reference_and_catalog.js`, `20261005120002_orders_and_inventory.js`, `20261005120003_ledger.js`, `20261005120004_reports_and_baseline.js`, `20261005120005_protections.js`.
- Seed-if-empty RAN this time (boot logged "products table empty; running seeds") and populated the catalog to match the `docs/EVALS.md` seed table exactly: `products` = 5 - MAG-GLY-120 (cogs 1450, on_hand 50), VITD3-K2 (1125, 40), OMEGA3-1000 (2280, 30), PROBIO-50B (2675, 5), ZINC-30 (690, 0); all `reserved_qty` = 0. Also `practices` = 2, `providers` = 2, `patients` = 2, `users` = 5.
- Idempotency: a second boot against the same database logged "products table has 5 rows; skipping seed", `migrate.latest()` was a no-op, no errors, and `products` stayed at 5 (no duplicate seeding).
- `GET /api/health` returned `200 {"status":"ok","db":{"connected":true}}`; the SPA still served at `/`; `process.env.PORT` still honored.
- Strict `npm ci` still succeeded in the image on this updated `main` ("added 420 packages").

### Live deploy - VERIFIED on Railway 2026-10-06
After the owner set `RAILWAY_TOKEN` + `RAILWAY_SERVICE=cerbo-api` and the service/domain were created, a CI `railway up` deployed successfully: Railway built the `Dockerfile`, the container booted, logged "products table empty; running seeds" (migrations + seed ran against the real Railway Postgres) and "API listening on :8080" with NO SSL error, and the live URL responded: `GET /api/health` -> 200 `{"status":"ok","db":{"connected":true}}`, `GET /` -> 200 SPA. A subsequent deploy of T3's code crash-looped (`@cerbo/money` MODULE_NOT_FOUND) until the runtime-packages fix above; see Troubleshooting.

## Troubleshooting (real symptoms seen during T12)
- **`railway up` -> "Multiple services found. Please specify a service via the --service flag."** The project has more than one service (e.g. `Postgres` + the app). Set the `RAILWAY_SERVICE` CI variable to the app service's **NAME** (not ID); the deploy job passes `--service "$RAILWAY_SERVICE"`.
- **Live site returns 502 "Application failed to respond."** The app crashed on boot. Pull logs: `RAILWAY_TOKEN=<tok> railway logs --service cerbo-api -e production -d --lines 100`. The one we hit was `Error: Cannot find module '@cerbo/money'` - a runtime package was missing from the image; fixed by copying all workspace packages in the Dockerfile runtime stage (see "Build/runtime details"). A **restart does not fix a missing-module crash** - it needs a rebuilt image (merge to `main` -> CI redeploy).
- **CI deploy went green but the app was down (false green).** `railway up` returns once the deployment is QUEUED, not when the app is healthy - it exits a few seconds after upload, before build/boot/healthcheck, even with `CI` unset (an `env -u CI` attempt did NOT change this at runtime). So `railway up` alone cannot gate the deploy, and `--ci` is worse (it exits even earlier, after build-only). The deploy job therefore polls `RAILWAY_HEALTHCHECK_URL` for HTTP 200 after `railway up` and fails if the site never comes up; that poll is the real gate. If `RAILWAY_HEALTHCHECK_URL` is unset the job fails loudly rather than skipping the gate.
- **`railway whoami` / `railway link` return Unauthorized.** You have a project token, not an account token - that is expected; use `RAILWAY_TOKEN` and the deployment/project commands, which do work. See "Auth model" above.
- **No public URL even though the deploy succeeded.** A service has no domain until one is generated - see step 4.
- **DB SSL:** the `postgres-ssl:18` image did NOT require client SSL over internal networking; `PGSSL` stayed unset and the connection worked. If a future connection needs SSL, set `PGSSL=true` on the app service.

## Cost
Railway has no permanent free tier. New users get a one-time 5 USD trial credit. The Hobby plan is 5 USD/month and includes 5 USD of usage; a small always-on API + Postgres typically adds a few USD of usage on top. The owner approved Hobby plus small usage. The worker does not spend anything.

## Redeploy / recovery (in priority order)
1. **Railway dashboard "Redeploy" on the last successful deployment - fastest, use this mid-demo.** It re-runs the already-built image with no rebuild (seconds), so if the live deployment dies during a demo this is the quickest way back. No CI involved.
2. **Rebuild-from-source redeploy via CI.** Trigger a fresh build+deploy without manufacturing a commit: either click **"Run pipeline" on `main`** in the GitLab UI (pipeline source `web`), or fire one programmatically with `glab api --method POST "projects/2107/pipeline?ref=main"` (source `api`). Both are admitted by `workflow:rules`; the `deploy-railway` job still only runs on `main` with `$RAILWAY_TOKEN`, so this rebuilds and redeploys after the guardrail + test stages pass. Slower than option 1 (full pipeline, a few minutes) but refreshes the image from source.
3. **Push to `main`** also redeploys: any merge to `main` fires a push pipeline whose `deploy-railway` job deploys the new build.

## Rollback
Redeploy the previous successful deployment from the Railway dashboard (option 1 above). Migrations are additive only, so rolling back code does not require rolling back schema.
