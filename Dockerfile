# Multi-stage build: compile web (Vite) and api (tsc), then a slim runtime that
# serves both from a single Node process (ADR-022). See docs/DEPLOY.md.

# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app

# Copy the whole repo (node_modules/dist excluded via .dockerignore) and do a
# clean, reproducible install from the lockfile. Copying everything up front means
# the build never silently breaks when a new workspace (e.g. packages/money) lands.
COPY . .
RUN npm ci

# Build every workspace (tsc for packages/*+api, Vite for web).
RUN npm run build --workspaces --if-present

# Prune to production dependencies for the runtime image.
RUN npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
# Built SPA served by the API in production.
COPY --from=build /app/apps/web/dist ./apps/web/dist

# Knex scans these directories on boot. tsc only emits .ts files, so when the
# migrations/seeds directories are empty (or hold only .gitkeep) they are absent
# from dist and knex.migrate.latest() throws ENOENT. Create them so a zero-migration
# boot succeeds; once T2 adds real .ts migrations/seeds this is a harmless no-op.
RUN mkdir -p apps/api/dist/db/migrations apps/api/dist/db/seeds

EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
