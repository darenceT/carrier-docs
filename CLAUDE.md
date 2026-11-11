# Carrier Docs

Retrieves policy documents (ID cards first) from insurance carrier portals: the user enters
carrier credentials, completes MFA, and sees their documents. Design decisions live in
`docs/design.md`; the step-by-step plan is the Build Guide.

## Stack

- TypeScript strict, ESM (`"type": "module"`, NodeNext resolution, `.js` extensions in imports)
- Server: Koa (`apps/server`), patchright for browser automation, better-sqlite3, pino, zod
- Web: Vite + React (`apps/web`); dev server proxies `/api`, `/healthz`, `/demo-portal` to :3000
- Mock carrier portal: `packages/mock-portal`, mounted at `/demo-portal`
- Tests: Vitest (`npm test`, files in `*/test/**/*.test.ts`), Playwright test (`npm run test:e2e`, `e2e/`)
- Deploy: Docker image on Render (`render.yaml`), auto-deployed after CI passes

## Layout (ports and adapters)

```
apps/server/src/
  infra/      config (zod), logger (pino, redacting), clock, crypto (AES-256-GCM)
  core/       pure domain: session state machine, ports (interfaces)
  store/      SessionStore implementations (memory, SQLite in DATA_DIR)
  antibot/    BrowserProvider, FingerprintProfile, EgressProvider, Pacing, BlockDetector
  browser/    browser pool
  session/    SessionManager
  api/        Koa routes, SSE
  carriers/<id>/  selectors.ts, adapter.ts (CarrierAdapter implementations)
```

Rule: `core/` depends on nothing outside itself. Adapters (store, antibot, carriers, api)
depend on `core/` ports, never the other way round. Carrier code never chooses its own
browser strategy; the anti-bot layer is selected per carrier in config.

## Stable error codes

Every failure maps to one of these codes (extend this list in one place, in `core/`):
`BAD_CREDENTIALS`, `MFA_INVALID`, `MFA_TIMEOUT`, `CARRIER_BLOCKED`, `CARRIER_CHALLENGE`,
`CARRIER_PAGE_CHANGED`, `CARRIER_UNAVAILABLE`, `SESSION_EXPIRED`, `BUSY`, `NOT_FOUND`,
`UNAUTHORIZED`, `RATE_LIMITED`, `VALIDATION_FAILED`, `INTERNAL`.
These follow the design's login outcomes (`ok | mfa_required | bad_credentials | blocked | changed`)
and BlockDetector labels (blocked, challenge, CAPTCHA, bad credentials, page changed, timeout).

## Working rules

- Tests with every change. `npm run lint && npm run typecheck && npm test` must pass.
- Small PRs into `main`; CI must be green.
- Develop locally with `npm run dev` (tsx watch) and `npm run dev:web` (Vite); deploy only at phase gates.

## Hard rules

1. Never log or print credentials, MFA codes, cookies or document contents. Use the
   redacting pino logger; no `console.*` in server code.
2. Never run live carrier logins. Only the human runs `scripts/live-*`. Work against
   fixtures (`fixtures/<carrier>/`) and the mock portal. Never point the spike harness
   (`apps/server/src/scripts/spike.ts`) at a carrier URL either; the human runs it.
3. Never commit `.env`, `data/` or `fixtures/raw/`. Fixtures must be scrubbed of PII.
