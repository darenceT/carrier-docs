# Carrier Docs

Retrieves insurance policy documents (ID cards first) from carrier portals.

> Work in progress. Phase 1 (scaffold, CI, first deploy) is in place; the full README
> (architecture, latency table, anti-bot results, AI usage) arrives at submission.

## Run locally

Requires Node 24.

```sh
cp .env.example .env      # then fill in real local secrets
npm ci
npm run dev               # Koa server on :3000 (tsx watch)
npm run dev:web           # Vite dev server, proxies the API to :3000
```

Or with Docker: `docker compose up --build`, then open http://localhost:3000.

## Checks

```sh
npm run lint
npm run typecheck
npm test                  # Vitest unit tests
npx playwright install chromium
npm run test:e2e          # Playwright, builds and starts the app on :3100
```

## Deploy

`render.yaml` defines the Render service (Docker, Starter plan, 1 GB disk at `/var/data`).
Render deploys automatically once CI checks pass on `main`.

Health checks: `GET /healthz` and `GET /healthz/disk` (write/read test on the data disk).
