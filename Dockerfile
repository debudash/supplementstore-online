# Multi-stage build: compile web (Vite) and api (tsc), then a slim runtime that
# serves both from a single Node process. See docs/DEPLOY.md.

# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app

# Install all workspace dependencies (dev deps needed to build).
COPY package.json package-lock.json* ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm install

# Copy sources and build every workspace (packages first, then apps).
COPY . .
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

EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
