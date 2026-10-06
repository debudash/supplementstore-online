# DEPLOY.md - Railway deployment

Verify each step against Railway's current dashboard and docs; the names below reflect common Railway usage and may differ slightly.

## Topology
- One Railway service built from the repo `Dockerfile` (API serves the built Vue app)
- One Railway Postgres database

## Dockerfile shape
1. Stage `build`: `npm ci`, build `packages/*`, `apps/web` (Vite), `apps/api` (tsc)
2. Stage `runtime`: Node 20 slim, copy built artifacts and production dependencies, `CMD ["node", "apps/api/dist/server.js"]`
3. `server.ts` on boot: run Knex migrations to latest, run seed if the products table is empty, start listening on `process.env.PORT`

## Environment variables
| Variable | Value |
|---|---|
| `DATABASE_URL` | Reference to the Railway Postgres connection string (Railway reference variable, typically `${{Postgres.DATABASE_URL}}`) |
| `PORT` | Provided by Railway |
| `NODE_ENV` | `production` |
| `DEMO_MODE` | `true` for the demo deployment (enables demo endpoints and restock) |
| `PGSSL` | Set if the connection requires SSL (internal Railway networking usually does not) |

## Steps
1. Create a Railway project, add Postgres
2. Add a service from the GitHub repo, builder = Dockerfile
3. Set variables above
4. Set health check path to `/api/health`
5. Enable auto-deploy on `main`
6. After first deploy: open the URL, switch roles, confirm seed data

## Rollback
Redeploy the previous successful deployment from the Railway dashboard. Migrations are additive only, so rolling back code does not require rolling back schema.
