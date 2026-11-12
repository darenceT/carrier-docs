# Carrier Docs

Retrieves insurance policy documents, ID card first, from carrier portals. The user picks a
carrier, enters their login, types the MFA code the carrier sends, and sees their ID card inline
in the browser; the other documents load behind it. A repeat visit reuses the saved, encrypted
carrier session and skips MFA.

```
 Browser (React)                 Koa server (one container)                    Carrier portal
 ───────────────                 ──────────────────────────                    ──────────────
 access code ─────────► access gate (signed cookies, rate limits)
 carrier + login ─────► SessionManager ── state machine, 1 browser slot, FIFO queue
        ▲                   │
        │ SSE status        ├─► anti-bot layer: browser strategy, fingerprint, egress, pacing
        │                   │      └─► BrowserPool (one patched Chromium, a context per user)
 MFA code ────────────►     ├─► CarrierAdapter (Demo | Progressive | Lemonade) ──────► login, MFA,
        │                   │                                                            in-page API
 ID card inline ◄───── document stream (no-store) ◄──────────── PDF ◄──────────────────────┘
                            └─► SessionStore (SQLite, AES-256-GCM): storage state, never passwords
```

Design decisions and their tradeoffs: [docs/design.md](docs/design.md). Spike results:
[docs/spike.md](docs/spike.md).

## Quick start

Requires Docker.

```sh
cp .env.example .env
docker compose up --build
```

Open http://localhost:3000 and enter the access code `local-dev-access-code`. `.env.example`
ships public local-only secrets, so nothing else is needed; the server refuses them on Render. CI
runs exactly these two commands on every pull request.

**Hosted:** https://carrier-docs.onrender.com, with the access code sent with the submission.

### Demo carrier (test fixture)

Pick **Demo carrier** to run the whole real flow (session manager, anti-bot layer, browser, SSE,
document streaming) against a mock portal served by the same app. It is a test fixture, not one
of the two carriers. Any password works.

| Username         | What happens                                      |
| ---------------- | ------------------------------------------------- |
| anything else    | MFA prompt; the code is `123456` (3 attempts)     |
| `demo-nomfa`     | Straight to documents                             |
| `demo-wrongpass` | `BAD_CREDENTIALS`                                 |
| `demo-blocked`   | `CARRIER_BLOCKED` (a carrier block page)          |
| `demo-slow`      | A 3 s slower portal, to watch the progress states |

Run the same username twice to see the fast path (no MFA). **Forget me** deletes the saved
session, so the next run asks for a code again.

### Without Docker

Requires Node 24.

```sh
cp .env.example .env
npm ci
npx -w apps/server patchright install chromium
npm run dev               # Koa server on :3000 (tsx watch), serves the mock portal
npm run dev:web           # Vite on :5173, proxies /api to :3000
```

## Supported carriers

| Carrier     | Login                        | Documents                                         | Status                                                                            |
| ----------- | ---------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| Progressive | Username, password, SMS code | In-page API; the ID card PDF comes back as base64 | Real login from Render passed (login, SMS code, repeat run on saved cookies)      |
| Lemonade    | Email, then SMS code         | In-page API returns a PDF link per policy         | Real login from Render passed (SMS code, policy PDF, repeat run on saved cookies) |

Loom walkthrough: _link to add_.

## Latency

Time to first document, measured on Render (Starter, 512 MB): from pressing **Get my documents**
(or submitting the MFA code) until the ID card bytes reach the browser. Time the user spends
reading and typing the code is excluded.

| Carrier     | First run (full login + MFA) | Repeat run (saved session) |
| ----------- | ---------------------------- | -------------------------- |
| Demo        | _to measure_                 | _to measure_               |
| Progressive | _to measure_                 | _to measure_               |
| Lemonade    | _to measure_                 | _to measure_               |

The table is for the app's own numbers: `GET /api/status` reports p50/p95 time to first document
per carrier, split by full login, fast path and pre-warmed.

Until those are filled in, the scripted real logins from Render (docs/spike.md, 2026-11-12) give
the scale. These are script timings with generous waits, not the app's:

| Carrier     | Login page | Credentials accepted | Code accepted | Repeat run on saved cookies |
| ----------- | ---------- | -------------------- | ------------- | --------------------------- |
| Progressive | 4.5 s      | 0.9 s                | 1.8 s         | account page in 6.6 s       |
| Lemonade    | 2.4 s      | 0.7 s (SMS sent)     | 0.9 s         | 3.7 s                       |

## Anti-bot and fingerprinting

The anti-bot layer (`apps/server/src/antibot/`) is chosen per carrier in config; carrier code
never picks its own browser or IP. Its parts:

- `BrowserProvider`: stock Playwright or patchright, headless or headed.
- `FingerprintProfile`: honest and consistent (a Linux Chrome UA matching the real browser
  version, en-US, America/Los_Angeles, 1920×1080), saved with the session.
- `EgressProvider`: direct, or through `EGRESS_PROXY_URL`.
- `Pacing`: human-like typing delays.
- `BlockDetector`: labels a page blocked, challenge, CAPTCHA or bad credentials.

What the spike measured (full table in docs/spike.md):

| Strategy            | `navigator.webdriver` | sannysoft, CreepJS   | Progressive login page | Lemonade login page  |
| ------------------- | --------------------- | -------------------- | ---------------------- | -------------------- |
| Stock headless      | true                  | clean (home)         | clean (home)           | clean (home)         |
| Stock new headless  | true                  | clean (home)         | clean (home)           | clean (home)         |
| patchright headless | false                 | clean (home, Render) | clean (home, Render)   | clean (home, Render) |

Decisions: patchright headless, with direct egress from Render's IP, for both carriers. Real
logins from Render passed for both: the datacenter IP was accepted through login and the SMS
code, with no block or challenge. No residential proxy unless the daily canary starts seeing
challenges.

## Session reuse and reliability

- **Fast path.** After a successful login, the browser storage state (cookies, local storage) is
  encrypted and saved per user and carrier for `SESSION_TTL_DAYS` (7). A repeat run checks it
  first and skips login and MFA if the carrier still accepts it; otherwise it falls back to a full
  login and replaces it.
- **Capacity.** One browser slot on 512 MB (one session measured at 320 MB). Further logins wait
  in a FIFO queue (up to 5, for `QUEUE_WAIT_S` 30 s), then get `BUSY`. The slot is freed as soon
  as the documents are fetched; they stay in memory for `DOCUMENT_CACHE_S` (10 min).
- **Failure classification.** Every failure maps to one stable code: `BAD_CREDENTIALS`,
  `MFA_INVALID`, `MFA_TIMEOUT`, `CARRIER_BLOCKED`, `CARRIER_CHALLENGE`, `CARRIER_PAGE_CHANGED`,
  `CARRIER_UNAVAILABLE`, `SESSION_EXPIRED`, `BUSY`, `NOT_FOUND`, `UNAUTHORIZED`, `RATE_LIMITED`,
  `VALIDATION_FAILED`, `INTERNAL`.

## Security

- Passwords and MFA codes are used once in memory and never stored or logged. The pino logger
  redacts credentials, codes, cookies and tokens; document contents are never logged.
- Saved sessions are AES-256-GCM ciphertext in SQLite; the owner ID is stored only as a keyed
  hash. A row that won't decrypt (for example after a `SESSION_KEY` rotation) is treated as
  missing, so the user simply logs in again.
- The whole API sits behind a shared access code (signed, httpOnly, SameSite=Lax cookies), with
  per-IP rate limits on the access code and on logins.
- helmet sets HSTS, `nosniff` and a content security policy. Documents are served `no-store`, and
  only allowlisted types inline.
- CI runs gitleaks and `npm audit`. Fixtures are scrubbed of PII.

## Production readiness

```sh
npm run lint
npm run typecheck
npm test                  # Vitest unit tests
npx playwright install chromium
RUN_BROWSER_TESTS=1 npx vitest run apps/server/test/carriers apps/server/test/browser
npm run test:e2e          # Playwright: the Demo carrier end to end through the real app
```

- **CI/CD.** GitHub Actions runs lint, types, unit, browser and e2e tests, the Docker build with
  the quick-start check, gitleaks and npm audit. Render deploys `main` once CI passes.
- **Health and canary.** `GET /healthz`. A daily workflow calls `POST /internal/canary`
  (`CANARY_TOKEN`), which loads each carrier's login page through the anti-bot layer from
  Render's IP and reports clean or challenged. It never logs in.
- **Status.** `GET /api/status` (behind the access code): per carrier, attempts, a count of each
  outcome, the block rate, and p50/p95 time to first document. In memory, so it resets on a
  redeploy; each login also logs one "login outcome" line.
- **Tracing.** Every API response carries an `X-Request-Id`, which is on that request's log
  lines; session routes also log the session ID.
- **Config.** Every environment variable is validated at startup; the server exits listing the
  bad variable names, never their values.
- **Shutdown.** On SIGTERM (a redeploy) the server refuses new logins with `BUSY`, ends queued
  ones with a retryable error, and gives logins already running up to 25 s to finish while it
  keeps answering. Then it closes connections, the browser and the store, and exits inside
  Render's 30 s.
- **Browser crash.** If Chromium dies mid-session, that session fails with `CARRIER_UNAVAILABLE`
  (retryable), the pool relaunches the browser, and the next login works. Tested by killing a
  real browser.

## Limits and next steps

- One container and one browser slot. At scale: a pool of browser workers behind a job queue,
  with a stateless API in front.
- Self-hosted stealth is an arms race. The canary is the early warning; the escape hatches are a
  residential proxy (`EGRESS_PROXY_URL`), headed mode (`patched-headed`), or a hosted browser
  vendor behind the same `BrowserProvider` port.
- AI agent adapter (a `CarrierAdapter` where a model drives an unfamiliar portal): costed in
  docs/design.md; _built or deferred: to decide_.

## AI usage

Built with Claude Code. Session links: _to add_ (docs/ai-sessions/).
