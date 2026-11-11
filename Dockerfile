# syntax=docker/dockerfile:1

# ---- build ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
# Toolchain for native modules (better-sqlite3 compiles from source when no prebuilt
# binary matches this Node version). Lives only in the build stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
# Manifests first, so npm ci is cached until dependencies change.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/mock-portal/package.json packages/mock-portal/
RUN npm ci
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
# Production dependencies, already compiled for this platform in the build stage.
COPY --from=build /app/node_modules node_modules
RUN npx -w apps/server patchright install --with-deps chromium \
 && chmod -R a+rx /ms-playwright \
 && npm cache clean --force \
 && mkdir -p /var/data && chown node:node /var/data
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/mock-portal/dist packages/mock-portal/dist
USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
