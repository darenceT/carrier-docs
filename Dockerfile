# syntax=docker/dockerfile:1

# ---- build ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
# Manifests first, so npm ci is cached until dependencies change. .npmrc turns off install
# scripts, so better-sqlite3 uses its bundled linux-x64 binary and no compiler is needed.
# The node -e line fails the build early if that binary doesn't load.
COPY package.json package-lock.json .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/mock-portal/package.json packages/mock-portal/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci \
 && node -e "new (require('better-sqlite3'))(':memory:').close()"
COPY . .
RUN npm run build \
 && npm prune --omit=dev

# ---- runtime ----
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DATA_DIR=/var/data
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/mock-portal/package.json packages/mock-portal/
COPY packages/contracts/package.json packages/contracts/
# Production dependencies, already compiled for this platform in the build stage.
COPY --from=build /app/node_modules node_modules
# procps provides `ps`, which the spike harness uses to measure browser memory.
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps \
 && rm -rf /var/lib/apt/lists/* \
 && npx -w apps/server patchright install --with-deps chromium \
 && chmod -R a+rx /ms-playwright \
 && npm cache clean --force \
 && mkdir -p /var/data && chown node:node /var/data
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/mock-portal/dist packages/mock-portal/dist
USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
