# Technical Design: Carrier Policy Document Retrieval

_Nov 10, 2026. Exported from the Technical Design doc; that doc is the source of truth if the two disagree._

The architecture is drafted: one Docker container on Render, TypeScript throughout, with a
swappable anti-bot layer. Three choices (D1–D3) wait on the day-one spike. Carrier #2 is
Lemonade (Q2). Where a choice rests on an answer, the answer is cited.

> **Reminder:** the AI AgentAdapter is a stretch goal; see [AI agent adapters](#ai-agent-adapters-cost-latency-and-a-combo-design).

Carrier #1 is Progressive (my own account). Carrier #2 comes from a sibling or friend (the
"lender") and is not chosen yet.

## Prioritized requirements

Ranked by risk first, then by how the assignment grades. Pass/fail gates come before graded
quality. The most uncertain item, a hosted login getting past anti-bot, is tackled first because
a block there invalidates everything built on top. Requirements that shape the architecture (a
stateful MFA session, session reuse) are designed in from day one even if built later.

| Rank | Requirement(s)                                                     | Tier    | Why this rank                                                                                                                                           |
| ---- | ------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | NFR Anti-bot + NFR Hosting: a login from a cloud host succeeds     | P0 gate | The biggest unknown; eval #3 explicitly rejects a laptop-only setup. If carrier login fails from the cloud, everything else is wasted. Spike this first |
| 2    | FR1, FR2, FR4, FR6, FR7: two carriers end to end                   | P0 gate | "If only one carrier works, we will not move you forward." A hard pass/fail                                                                             |
| 3    | FR3 + FR4 + FR5: login state machine, holding the session over MFA | P0 gate | Decides the architecture: a live browser must survive between two HTTP requests, which rules out stateless serverless                                   |
| 4    | NFR Security + FR9: credential handling and specific errors        | P1      | "Production ready matters more." Mishandling a lender's password is the fastest way to look unproduction-ready                                          |
| 5    | NFR Latency: under 8 s                                             | P1      | Eval #4. Depends on ranks 1 and 3 (warm browsers, fetch after login), so designed early, tuned late                                                     |
| 6    | FR8 + NFR Reliability: session reuse and safe retries              | P1      | Eval #5. Also cuts MFA requests to the lender and is the largest latency win                                                                            |
| 7    | NFR Observability: per-step timing, redacted logs                  | P1      | Without timings, rank 5 can't be shown. Without failure traces, debugging a live portal burns the lender's logins                                       |
| 8    | NFR Hosting (packaging): Docker, README, local run                 | P1      | Eval #1. Cheap, but required                                                                                                                            |
| 9    | NFR Maintainability: carrier-adapter interface                     | P2      | Makes carrier #2 faster to add and signals good design; not graded on its own                                                                           |
| 10   | NFR Testing                                                        | P2      | Adapter tests against recorded fixtures also protect the lender's account. Broad coverage isn't worth it in 48 h                                        |
| 11   | NFR Concurrency: multiple users                                    | P2      | Reviewers run it once or twice. Isolation per session is a must (security); scale beyond a few sessions is not                                          |
| 12   | Frontend look and feel                                             | P3      | "Keep it ugly, we care about it working"                                                                                                                |

## Language and runtime

Language barely affects latency: the 8 s budget goes on carrier round-trips, page loads and
browser start-up (seconds), not language speed (milliseconds). The real differences are in
anti-bot tooling.

| Factor                      | JavaScript / TypeScript (Node) | Python                                           | Go                            |
| --------------------------- | ------------------------------ | ------------------------------------------------ | ----------------------------- |
| Effect on the 8 s budget    | Negligible                     | Negligible                                       | Negligible                    |
| Browser automation          | Playwright (native), Puppeteer | Playwright (official binding)                    | chromedp, rod: less ergonomic |
| Patched or stealth browsers | rebrowser-patches, patchright  | patchright, Camoufox (Firefox-based), nodriver   | Few                           |
| HTTP with browser-like TLS  | Weaker, mostly wrappers        | curl_cffi: mature, impersonates Chrome TLS/HTTP2 | utls / tls-client: strongest  |
| Real-time backend (SSE, WS) | Strong                         | Fine (FastAPI)                                   | Strong                        |
| One language front and back | Yes                            | No                                               | No                            |

**Decision:** TypeScript end to end. Python wins only if the spike shows that (a) patched
Playwright is detected and Camoufox is not, or (b) documents must be fetched over plain HTTP and
the carrier fingerprints TLS. Then a small Python worker behind the Node API is the fallback.

## Open questions (grill), answered

All answered except Q2.

| #   | Question                                   | Answer / decision                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | How does Progressive MFA arrive?           | SMS; "remember this device" is offered. Saving the device-trust cookie after the first MFA should let repeat runs skip MFA                                                                                                                                             |
| Q2  | Lender's carrier and timing                | **Answered.** Lemonade (renters). Its login is email only, then an SMS code to the lender's phone (confirmed on its login page, 2026-11-11). See "Carrier login methods"                                                                                               |
| Q3  | Budget                                     | Free first, a few dollars at most, no vendors. Start with the host's own IP; a small pay-as-you-go proxy only if the spike is blocked. Cheapest paid Render instance is OK                                                                                             |
| Q4  | Cloud                                      | Render: long-lived Docker web services fit D4-B. Free instance is out (sleeps, too little RAM)                                                                                                                                                                         |
| Q5  | Store passwords?                           | Never (D7-A). Saved cookies plus the device-trust token give session reuse without the password                                                                                                                                                                        |
| Q6  | What the 8 s covers                        | Assume 2 s for the human's MFA typing; the clock stops at the first document on screen. Measure "first document on screen" (headline) and "full list loaded" separately; state both in the README                                                                      |
| Q7  | Which documents                            | ID cards first, timed; fall back to the declarations page for policies without an ID card (home, renters). Everything else loads lazily                                                                                                                                |
| Q8  | TypeScript, and a Python worker if needed? | Yes to both. TypeScript throughout, Python worker as fallback                                                                                                                                                                                                          |
| Q9  | Deadline                                   | 2 days, up to 20 hours of work. Points to D4-B: one container, no worker pool or queue                                                                                                                                                                                 |
| Q10 | Who uses the hosted URL?                   | Reviewers too. One shared access code (env var), entered once and kept in a signed cookie, plus a per-IP rate limit on login. No user accounts                                                                                                                         |
| Q11 | Recognizing a returning user               | Random ID in a signed browser cookie + carrier + hash of the username; all must match. Username alone would let anyone who types it get the session                                                                                                                    |
| Q12 | Retention                                  | Saved sessions encrypted, 7-day expiry, deleted early if the carrier rejects them. Documents not stored at rest: streamed on demand, cached in memory only while the browser session is open (closed after 3 min idle). "Forget me" deletes everything. No PII in logs |
| Q13 | Concurrent sessions                        | Cap at 3, reject extras with "busy, retry". Each live browser uses hundreds of MB                                                                                                                                                                                      |
| Q14 | Frontend                                   | Vite React app served from the same Node server (D11-B)                                                                                                                                                                                                                |
| Q15 | Location / egress                          | Seattle. Render's Oregon region                                                                                                                                                                                                                                        |
| Q16 | Playwright / anti-bot experience           | Playwright for e2e testing only. Stealth work is new, so the spike gets extra time                                                                                                                                                                                     |
| Q17 | Headless vs headed                         | Let the spike decide: patched headless first, headed under Xvfb if blocked, stock new-headless as a baseline. See [D2](#d2-browser-and-stealth)                                                                                                                        |
| Q18 | Status transport                           | SSE for status, POST for the MFA code, 250 ms polling fallback if Render's proxy buffers streams. See [D8](#d8-how-the-frontend-learns-the-job-status)                                                                                                                 |
| Q19 | Test bar                                   | Unit tests on adapters, e2e against recorded fixtures, CI, and manual testing                                                                                                                                                                                          |
| Q20 | CI/CD                                      | GitHub Actions CI on PRs; Render auto-deploy on merge to `main` after checks pass                                                                                                                                                                                      |

## Architecture

### Overview

The whole app is one Docker container on Render: one thing to deploy, and live browser sessions
survive the MFA wait because they never leave the process. Each layer talks to the one below only
through an interface, so any layer can be faked in tests or swapped later.

```
browser (React UI) ──HTTP/SSE──▶ API (Koa)
                                   │
                                   ▼
                             SessionManager ───────────▶ SessionStore (encrypted SQLite on disk)
                                   │
                                   ▼
                          CarrierAdapter (per carrier)
                                   │
                                   ▼
                     Anti-bot layer ──▶ Browser pool (one warm Chromium)
```

Requests enter through the API. The session manager drives a carrier adapter, which gets its
browser from the anti-bot layer and the warm Chromium pool. The session manager also saves and
restores encrypted sessions in the store.

### Decisions

| Decision               | Pick                                                                                            | Status                               | Based on                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------- |
| D1 Automation          | B: browser for login and MFA, then document calls made from inside the page                     | Proposed; spike confirms per carrier | Latency (Q6), keeping the browser's TLS fingerprint |
| D2 Browser and stealth | C: patched headless, falling back to D (headed under Xvfb); B as baseline                       | Proposed; spike confirms             | Q17                                                 |
| D3 Egress IP           | A: Render's own IP, with a pinned proxy as the paid fallback                                    | Proposed; spike confirms             | Q3 budget                                           |
| D4 Hosting             | B: one long-running Docker container on Render's cheapest paid instance, Oregon                 | Decided                              | Q3, Q4, Q9, Q15                                     |
| D5 MFA session hold    | A: in-process map of live browser contexts                                                      | Decided                              | Follows from D4                                     |
| D6 Saved sessions      | B: encrypted SQLite on a Render persistent disk, behind a SessionStore interface (Redis later)  | Decided                              | Q11, Q12, D4                                        |
| D7 Credentials         | A: never stored; held in memory only during login                                               | Decided                              | Q5                                                  |
| D8 Status updates      | SSE for status, POST for the MFA code                                                           | Decided                              | Q18                                                 |
| D9 Documents           | C + A: list first, the first ID card fetched eagerly, the rest lazily, all streamed, not stored | Decided                              | Q6, Q7, Q12                                         |
| D10 Browser lifecycle  | B: one warm Chromium process, a fresh context per session                                       | Decided                              | Q6, Q13                                             |
| D11 Frontend           | B: Vite React app served by the same server                                                     | Decided                              | Q14                                                 |

**Render constraints (checked Nov 2026):** persistent disks work on any paid instance, Starter
included, not on Free, so D6-B stands. Accepted costs: no zero-downtime deploys (a few seconds of
downtime per deploy), no scaling past one instance, and the disk can't be read during the build.
Render Key Value is not a better fallback: its free tier is 25 MB with no persistence.

**Memory risk:** Starter ($7/month, 0.5 CPU, 512 MB RAM) is tight for Node plus Chromium and
probably too small for 3 concurrent sessions. The spike measures memory per session. If it
doesn't fit, lower the cap to 1–2 on Starter, or move up a plan for the review period only
(Render bills by the second).

### Carrier login methods

The two carriers log in differently, so the login form is declared per carrier rather than fixed.
Both end in an SMS code, so the MFA step, the state machine and the SSE events stay as they are.

| Carrier            | Step 1                  | Step 2                                    | Code goes to       |
| ------------------ | ----------------------- | ----------------------------------------- | ------------------ |
| Progressive        | Username + password     | SMS code ("remember this device" offered) | Your phone         |
| Lemonade (renters) | Email only, no password | SMS code                                  | The lender's phone |

Changes this needs (confirmed on Lemonade's login page, 2026-11-11):

- **Contract:** `CarrierInfo` gains `loginFields`, e.g. `['username', 'password']` for Progressive
  and `['email']` for Lemonade. `StartSessionRequest` makes `password` optional and adds an
  optional `email`. The API requires exactly the fields the chosen carrier declares.
- **UI:** the login form renders the fields from `loginFields`; Lemonade shows a single email field.
- **Adapter:** Lemonade's adapter submits the email, then reports `mfa_required` with a hint such as
  "Code sent by text". From there the flow is identical to Progressive's.
- **Saved sessions:** the reuse key uses whichever identifier the carrier logs in with (username or
  email), hashed the same way.
- **Operations:** every fresh Lemonade login needs the lender to text you the code, so session reuse
  matters more for Lemonade. Whether Lemonade offers "remember this device" is checked in its
  mapping login. The lender must be reachable during the Loom; schedule it.

### Components and interfaces

Ports and adapters (hexagonal): the core session logic depends only on interfaces; real browsers,
carriers, storage and time plug in from outside. That one rule makes every layer testable.

| Component                        | Responsibility                                                                                                       | Depends on (interfaces)                              | Fake used in tests                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| API (Koa)                        | Routes, zod validation, access-code gate, rate limit, SSE stream, serving the React build                            | SessionManager                                       | supertest against the request handler        |
| SessionManager (core)            | Login state machine per session, the session cap, MFA and idle timeouts, status events, fast path for saved sessions | CarrierAdapter, BrowserProvider, SessionStore, Clock | Fake adapter, fake clock, in-memory store    |
| CarrierAdapter (one per carrier) | Log in, submit MFA, check a saved session, list documents, fetch one document; selectors in a separate file          | A page handed in by the core                         | Recorded page fixtures, or the mock portal   |
| Anti-bot layer                   | BrowserProvider, FingerprintProfile, EgressProvider, Pacing, BlockDetector (see D2)                                  | Playwright or patchright                             | Stock Playwright against the mock portal     |
| Browser pool                     | One warm Chromium process; creates and disposes an isolated context per session                                      | BrowserProvider                                      | Not needed: the core only sees the interface |
| SessionStore                     | Save, load and delete encrypted session state (cookies, storage, device profile) with a 7-day TTL                    | Crypto                                               | In-memory store                              |
| Crypto, Config, Logger, Clock    | AES-256-GCM with the key from an env var; typed config; pino logs with redaction; injectable time                    | —                                                    | Fixed key, fake clock                        |

The core interface, in outline:

```ts
interface CarrierAdapter {
  id: 'progressive' | string;
  login(page: Page, creds: Credentials): Promise<LoginOutcome>; // ok | mfa_required | bad_credentials | blocked | changed
  submitMfa(page: Page, code: string): Promise<LoginOutcome>;
  isSessionValid(page: Page): Promise<boolean>;
  listDocuments(page: Page): Promise<DocumentMeta[]>; // ID cards first
  fetchDocument(page: Page, docId: string): Promise<ReadableStream>;
}
```

Repo layout (one repo, npm workspaces):

```
apps/
  server/src/
    api/          routes, SSE, access gate, rate limit
    core/         SessionManager, state machine, types
    carriers/
      progressive/  adapter.ts, selectors.ts, fixtures/
      <carrier2>/   adapter.ts, selectors.ts, fixtures/
    antibot/      providers/, fingerprint/, egress/, pacing/, detect/
    store/        sqlite-store.ts, memory-store.ts
    infra/        crypto, config, logger, clock
  web/            Vite React UI
packages/
  mock-portal/    fake carrier with login, MFA and PDFs, for tests
scripts/          spike harness, canary
e2e/              Playwright tests of the whole app
Dockerfile  render.yaml  .github/workflows/
```

### Request flow

A repeat run takes the fast path: the saved session is checked first, which skips both login and
MFA. Every state change goes to the UI as an SSE event. A failure at any step sends `failed` with
a reason and whether a retry makes sense, then closes the browser context.

1. **Start.** Two calls, so the login page can load while the user types.
   - **Carrier pick:** `POST /api/sessions` with `{ carrier }`. The server checks the session cap
     (over the cap: `429`, "busy, retry"), returns a session ID and starts pre-warming the login
     page (`prewarming`). The UI opens `GET /api/sessions/:id/events` right away. Picking a
     different carrier creates a new session and closes this browser's unused pre-warm, so flipping
     the dropdown never holds more than one slot. An unused pre-warm closes after 2 minutes; a later
     login on it gets `SESSION_EXPIRED`, and the UI starts over with a new session.
   - **Submit:** `POST /api/sessions/:id/login` with `{ username, password }`. The server
     validates the input and continues from step 2, reusing the pre-warmed page. This call is
     accepted once per session, and only while it is `idle` or `prewarming`.
2. **Fast path.** Build the reuse key: browser-cookie ID + carrier + username hash. If the store
   has a saved session for it, open a context with the saved cookies and the same device profile,
   then call `isSessionValid`. Valid: skip to step 6. Expired: delete it and continue.
3. **Login.** Take a fresh context from the warm pool (device profile + egress), then
   `adapter.login`. The password is dropped from memory once this call returns. `ok` (trusted
   device, no MFA): go to step 5. `mfa_required`: step 4. `bad_credentials`, `blocked` or
   `changed`: send `failed` with that reason.
4. **MFA.** Send `mfa_required`; the UI shows the code field. The user submits
   `POST /api/sessions/:id/mfa`. The adapter enters the code and ticks "remember this device".
   Wrong code: `mfa_required` again with a message, up to 3 tries. No code within 5 minutes:
   `failed` (`mfa_timeout`), and the context closes.
5. **Save.** Encrypt the session state (cookies, storage, device profile) with a 7-day TTL.
6. **First document.** `adapter.listDocuments` → `documents_listed`; the UI shows the list. The
   first ID card is fetched right away into an in-memory cache, then `document_ready`. The UI
   renders it inline from `GET /api/documents/:id`. **The latency clock stops here.**
7. **The rest, lazily.** Other documents are fetched on click through the same live context. The
   context closes after 3 minutes idle, freeing its slot. A later click reopens it from the saved
   session (fast path, about 1 s).

**Capacity.** The cap is on live browser contexts at the same moment, not on users. Counted: a
login in progress, an open session within its 3-minute idle window, and a pre-warmed login page
(closed after 2 minutes unused). SSE streams, page loads and API calls don't count. The cap is one
config value (`MAX_SESSIONS`), set from measured memory per session. Beyond that, scale means the
worker-pool design (alternative B).

### Latency budget

A first run with MFA lands at about 7.9 s against the 8 s target: tight. A repeat run is about
2.7 s. These are design targets; the spike replaces them with measurements, and every step is
logged and sent to the UI.

| Step                                                | First run with MFA (s) | Repeat run, fast path (s) |
| --------------------------------------------------- | ---------------------- | ------------------------- |
| POST, plus a context from the warm pool             | 0.2                    | 0.2                       |
| Load the login page (including the anti-bot sensor) | 1.5                    | —                         |
| Submit credentials, reach the MFA page              | 1.5                    | —                         |
| Human types and submits the MFA code (assumed, Q6)  | 2.0                    | —                         |
| MFA accepted, logged in                             | 1.2                    | —                         |
| Check the saved session                             | —                      | 1.0                       |
| List documents (a call made from inside the page)   | 0.6                    | 0.6                       |
| Fetch the first ID card PDF                         | 0.6                    | 0.6                       |
| Stream to the UI and render                         | 0.3                    | 0.3                       |
| **Total**                                           | **7.9**                | **2.7**                   |

Levers to win back margin, in order of value:

- **Pre-warm on carrier pick:** load the login page in the background while the user types
  (about 1.5 s). Counts toward the cap; closes after 2 minutes unused.
- **Go straight to the right URLs:** the login URL, then the document APIs; no clicking through menus.
- **Block heavy resources anti-bot doesn't watch** (images, video). Never block scripts: blocking
  the sensor script trips detection.
- **Fetch the list and the first ID card in parallel** where the portal's API allows it.
- **SSE**, so no polling delay.

## Testability

No automated test ever touches a real carrier. Real portals are slow, rate-limited, need MFA
codes from a real phone, and risk locking the lender's account.

- **Dependency injection at the core.** SessionManager receives its CarrierAdapter,
  BrowserProvider, SessionStore and Clock through its constructor.
- **Injectable clock.** MFA timeouts (5 min), idle closes (3 min) and TTLs (7 days) are tested in
  milliseconds.
- **Pure state machine.** `(state, event) → new state`, unit-tested with no I/O.
- **Mock portal package.** Login form, MFA page with a fixed code, document list, sample PDFs,
  with failure modes: wrong password, wrong code, block page, slow responses.
- **Recorded fixtures.** HTML snapshots and HAR files from the spike, PII scrubbed, replayed with
  Playwright's `routeFromHAR` so adapter tests run offline.
- **Selectors in their own file**, so a portal redesign shows up as a failing fixture test that
  points at one file.

| Level            | Tool                          | What it covers                                                                                                                                       | Runs in CI                                    |
| ---------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Unit             | Vitest                        | State machine transitions; timeouts with a fake clock; encrypt/decrypt round trip; reuse-key derivation; log redaction; BlockDetector on saved pages | Yes                                           |
| Adapter contract | Vitest + Playwright, fixtures | Each adapter's login, MFA, list and fetch against its recorded pages; one shared contract suite every adapter must pass                              | Yes                                           |
| API integration  | Vitest + supertest            | Endpoints, validation, access gate, rate limit, 429 at the cap, order of SSE events, with a fake adapter                                             | Yes                                           |
| End to end       | Playwright                    | The React UI through the real server against the mock portal: MFA path, no-MFA path, wrong code, block, repeat-run fast path, "Forget me"            | Yes                                           |
| Live smoke       | Spike harness script          | Real carriers from the Render deployment; prints timings per step                                                                                    | No: manual, opt-in, failed-login cap enforced |
| Canary           | Scheduled GitHub Action       | Login pages load without a challenge, without logging in                                                                                             | Daily                                         |
| Manual           | You                           | Exploratory runs before the Loom                                                                                                                     | —                                             |

## Security

Passwords are never stored, and nothing sensitive is kept unencrypted. OWASP basics, scaled to a
2-day project.

| Threat                                              | Control                                                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Strangers using the hosted app, credential stuffing | Shared access code from an env var, exchanged for a signed httpOnly cookie. Per-IP rate limits on login (koa-ratelimit). Session cap   |
| Password exposure                                   | Held in memory only for the login call, then dropped. Never logged (pino redact paths), never written to disk, never in error messages |
| Theft of saved sessions                             | AES-256-GCM with the key from an env var. 7-day TTL. Deleted when the carrier rejects them. "Forget me" deletes them on demand         |
| One user getting another's session                  | Reuse key = signed cookie ID + carrier + username hash; all must match. A separate browser context per session                         |
| Interception in transit                             | HTTPS everywhere (Render terminates TLS). Cookies `Secure` and `SameSite=Lax`                                                          |
| CSRF and common web attacks                         | SameSite cookies, JSON-only POST bodies, security headers (koa-helmet), zod validation on every input                                  |
| PII leaking through logs, fixtures or screenshots   | Log redaction is unit-tested. Fixtures scrubbed before commit. Failure screenshots off in production; in development they mask inputs  |
| Documents at rest                                   | Not stored: cached in memory only while the browser session is open (closed after 3 minutes idle)                                      |
| Leaked secrets in the repo                          | Secrets only in Render env vars and a gitignored `.env`. gitleaks runs in CI                                                           |

## Deployment, CI/CD and observability

### Deployment

- **Image:** multi-stage Dockerfile, build stage compiles the server and React app, runtime stage
  runs as a non-root user. _(The design called for the official Playwright base image; the build
  uses `node:24-bookworm-slim` plus `patchright install --with-deps chromium` instead, per the
  Build Guide.)_
- **Infrastructure as code:** `render.yaml` Blueprint defines the web service (Oregon, cheapest
  paid plan), the disk mount, the health-check path and the env-var names. Secrets
  (`ACCESS_CODE`, `SESSION_KEY`, `CANARY_TOKEN`) are set in Render, never committed.
- **Fail-fast config:** env vars validated with zod at boot; a missing or malformed value stops the
  service with a clear error.
- **Graceful shutdown:** on SIGTERM, stop accepting new sessions, give in-flight logins up to
  30 s, close the browsers, flush the logs. A service with a disk gets no zero-downtime deploys,
  so avoid deploying during a demo.

### CI/CD (GitHub Actions + Render)

1. A PR runs lint (ESLint), typecheck (tsc), unit, contract and integration tests, end-to-end
   tests against the mock portal, a Docker build, and a secret scan.
2. Branch protection on `main` requires green CI plus review before merge.
3. A merge to `main` triggers Render's auto-deploy in "After CI Checks Pass" mode
   (`autoDeployTrigger: checksPass`), then Render health-checks the new instance.
4. A daily scheduled workflow calls a token-protected canary endpoint on the deployed service, so
   the login-page check runs from Render's IP rather than GitHub's.

### Observability

- **Logs:** pino JSON with a request ID and session ID on every line; passwords, codes and cookies
  redacted. Viewed in Render's log stream.
- **Timings:** every step records its duration, to the logs and to the UI over SSE; feeds the
  README latency table.
- **Health:** `/healthz` for liveness (process up) and readiness (browser pool alive).
- **Status:** behind the access code, `/api/status` shows counts per carrier and outcome, the block
  rate, and p50/p95 time to first document.
- **Errors:** every failure carries a stable error code (for example `CARRIER_BLOCKED`,
  `MFA_TIMEOUT`), so the UI, logs and tests share one vocabulary.

## Major design decisions: options and tradeoffs

D1–D5 are the expensive ones to reverse.

### D1. How to automate each portal

| Option                                                                    | Pros                                             | Cons                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| A. Full browser for everything                                            | Most like a real user. Least reverse-engineering | Slowest: every page load counts against 8 s. Breaks when the UI changes           |
| **B. Hybrid: browser for login and MFA, then the portal's internal APIs** | Much faster document fetch. Fewer pages rendered | Requires mapping internal endpoints. HTTP calls may be TLS-fingerprinted (see D2) |
| C. Pure HTTP: replay the login API without a browser                      | Fastest, cheapest, no browser to host            | Bot-protection sensor scripts usually make this impractical. Most brittle         |

Decided by Q6, Q7 and the spike (does the HAR show clean JSON or PDF endpoints?). Document calls
run from inside the page with the browser's `fetch`, keeping its TLS fingerprint and cookies.

### D2. Browser and stealth

**Decision:** self-hosted patched Playwright. Spike patched headless first, fall back to patched
headed under Xvfb, run stock new-headless as a baseline. Stock lightweight headless and managed
vendors are dropped. The final pick per carrier comes from the spike.

| Option                                    | Detection risk                                                 | RAM per browser              | Image and setup                         | Cold start                    | Build effort                  |
| ----------------------------------------- | -------------------------------------------------------------- | ---------------------------- | --------------------------------------- | ----------------------------- | ----------------------------- |
| A. Stock Playwright headless              | Highest: best-known automation tells                           | Lowest                       | Smallest                                | Fastest                       | None                          |
| B. Stock Chrome "new headless" (baseline) | High: fewer rendering tells, automation flags remain           | Low to medium                | Small; a different browser channel      | Fast                          | Minimal                       |
| **C. Patched headless (patchright)**      | Medium: removes the common leaks; some headless signals remain | Low to medium                | Small; one npm swap                     | Fast                          | Low: same API as Playwright   |
| D. Patched headed under Xvfb (fallback)   | Lowest self-hosted: real rendering, GPU and window signals     | Highest: rendering plus Xvfb | Larger: Xvfb and fonts in the container | Slower; a warm pool hides it  | Medium: process supervision   |
| E. Managed browser vendor                 | Low                                                            | None on our host             | None                                    | Remote round trip per command | Low. Ruled out by budget (Q3) |

If D is needed, 3 headed sessions may not fit in 512 MB, and the cap or instance size changes.

#### Anti-bot and fingerprinting as a swappable module

Detection vendors update constantly, so whatever passes today will eventually fail. Carrier
adapters never launch a browser or pick an IP themselves; they ask the anti-bot layer for a ready
session, and the strategy is chosen per carrier in config. Swapping strategies is a new class plus
a config change, with no edits to carrier code.

| Interface          | Job                                                                         | Built now                                              | Can be added later                                                                   |
| ------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| BrowserProvider    | Launch or reuse a browser and hand back a context                           | Patched headless; stock new-headless (baseline)        | Headed under Xvfb; remote browser over CDP or a vendor; Camoufox via a Python worker |
| FingerprintProfile | One coherent device identity: UA, platform, locale, timezone, screen, scale | One profile per user + carrier, saved with the session | Profile pools, per-carrier tuning                                                    |
| EgressProvider     | Which IP traffic leaves from, pinned for the whole session                  | Direct (Render's own IP)                               | Static ISP or sticky residential proxy                                               |
| Pacing             | Human-like typing and click delays                                          | Off, or light jitter on the login form only            | Fuller behavior simulation                                                           |
| BlockDetector      | Classify each page: ok, challenge, CAPTCHA, blocked, bad credentials        | Rules for Progressive and carrier #2                   | Better signatures as they are seen                                                   |

Selection is per carrier in config, e.g. `PROGRESSIVE_BROWSER=patched-headless`. An optional
fallback chain (C, then D) runs only on a detected block, never on bad credentials, and each
fallback counts against the cap of two failed logins per day. Keep it thin: five small
interfaces, one or two implementations each.

**Fingerprinting (eval #6): coherence plus consistency.** Every signal tells the same story, and a
returning user looks like the same device.

| Rule                                                                               | Why                                                                                   | Tradeoff                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| UA and client hints match the browser binary actually running; no version spoofing | A version mismatch between UA and engine features is an easy tell                     | Claimed version follows whatever Playwright ships     |
| Timezone and locale match the egress IP: `America/Los_Angeles`, `en-US` for Oregon | Timezone vs IP geolocation is a classic check                                         | Pins the app to one region's IP                       |
| Realistic screen and viewport (1920×1080 at scale 1), not the 1280×720 default     | Default automation sizes are fingerprintable                                          | —                                                     |
| Stay honest about the OS (Linux) rather than faking Windows                        | Fonts, WebGL and `navigator.platform` would contradict a fake OS                      | Linux desktops are rarer and may score slightly worse |
| Save the profile with the session and reuse it every run                           | "Remember this device" and risk scoring rely on the same device returning             | Profile stored encrypted alongside cookies            |
| Same IP for the whole session                                                      | An IP change mid-session can void it or re-trigger MFA                                | No IP rotation inside a session                       |
| Document fetches from inside the page with the browser's `fetch` (D1-B)            | Keeps the real TLS fingerprint and cookies; removes the need for curl_cffi and Python | Fetches still need a live page                        |
| Known weak spot: headless WebGL reports a software renderer (SwiftShader)          | Common headless signal                                                                | Accept it, or move to headed or a vendor if blocked   |

Evidence for the README: the spike harness runs each strategy against each carrier from Render and
logs outcome (passed, challenge, blocked) and timings. Its results table becomes the "what we
tried, what worked, tradeoffs" section.

#### Future-proofing and operations

| Mechanism                                        | What it does                                                                                                 | Catches                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Failure classification                           | BlockDetector labels every failed login: blocked, challenge, CAPTCHA, bad credentials, page changed, timeout | "Carrier started blocking us" vs user error or a bug     |
| Block-rate tracking                              | Counts outcomes per carrier and strategy; health endpoint flags a rising block rate                          | Gradual tightening of detection                          |
| Daily login-page canary                          | Loads each login page through the anti-bot layer; never logs in                                              | Detection changes, with no risk to accounts or MFA codes |
| Re-runnable spike harness                        | Strategy-by-carrier matrix stays in the repo as a script                                                     | Finding the new working strategy quickly                 |
| Selectors in one file per carrier, fixture tests | Recorded fixtures fail adapter tests when a selector stops matching                                          | Portal redesigns, located to one file                    |
| Pinned dependency versions                       | patchright and Playwright upgraded only through CI and the harness                                           | An upgrade silently breaking logins                      |
| Escape hatch                                     | A remote-browser BrowserProvider (CDP) can point at a paid vendor                                            | The self-hosted approach losing the arms race            |

### D3. Egress IP

| Option                                   | Pros                                                                | Cons                                                          |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| **A. The host's own datacenter IP**      | Free, fastest, simplest                                             | Datacenter ranges are often flagged by bot protection         |
| B. Rotating residential, sticky sessions | Good IP reputation                                                  | Costs per GB. Extra latency. Must pin one IP per user session |
| C. Static ISP proxy                      | Near-residential reputation; stable IP helps device trust and reuse | Monthly cost. Fewer providers                                 |
| D. Bundled with a managed browser vendor | No separate setup                                                   | Little control over the IP                                    |

Decided by Q3, Q15 and the spike.

### D4. Hosting and compute

| Option                                               | Pros                                                     | Cons                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| A. Serverless functions                              | Cheap, scales to zero                                    | Can't hold a browser across the MFA wait. Cold starts                 |
| **B. One long-running container (Render)**           | Simplest way to hold sessions in memory. Easy to explain | Single point of failure. Scaling needs sticky routing                 |
| C. Stateless API + browser worker pool + queue       | Production shape: scale API and workers separately       | More moving parts than 48 h allows                                    |
| D. Container with min instances and session affinity | Managed scaling, warm instances                          | Affinity is best-effort; an MFA submit can land on the wrong instance |

### D5. Holding the live session across the MFA step

| Option                                                     | Pros                              | Cons                                                 |
| ---------------------------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| **A. In-process map of session ID → live browser context** | Trivial to build                  | Lost on restart. One instance or sticky routing only |
| B. Worker owns the browser; API relays MFA over a queue    | Survives API restarts. Scales out | More code and infrastructure                         |
| C. Remote browser over a CDP websocket                     | Any API instance can reconnect    | Network latency per command. Needs a browser service |

### D6. Where saved sessions live

| Option                                | Pros                                           | Cons                                                       |
| ------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| A. Memory only                        | Nothing at rest to protect                     | Lost on every restart, undermining session reuse (eval #5) |
| **B. Encrypted SQLite on a volume**   | Simple, survives restarts                      | Tied to one instance                                       |
| C. Redis, encrypted values with a TTL | Fast, shared across instances, built-in expiry | One more service                                           |
| D. Postgres, encrypted columns        | Durable, queryable, auditable                  | Heavier than needed for blobs with a TTL                   |

### D7. Credential handling

| Option                                                        | Pros                                | Cons                                                                     |
| ------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| **A. Never store; hold the password in memory during login**  | Strongest security story            | When a saved session expires, the user re-enters the password, maybe MFA |
| B. Store encrypted, for silent re-login                       | Best reliability and repeat latency | A password vault becomes a high-value target. Key management             |
| C. Encrypted credentials in the user's browser, key on server | No password database on the server  | Complex. Modest real gain                                                |

### D8. How the frontend learns the job status

**Decision:** SSE for status, a plain POST for the MFA code, with 250 ms polling as the fallback
if Render buffers the stream. The 8 s budget feels transport delay twice: when the MFA prompt
appears and when the first document is ready.

| Option                    | Added delay per status change                      | Server effort                               | Client effort                  | Reconnects  | Hosting fit                                                                           |
| ------------------------- | -------------------------------------------------- | ------------------------------------------- | ------------------------------ | ----------- | ------------------------------------------------------------------------------------- |
| A. Short polling (500 ms) | ~250 ms average, twice in the budget (~0.5 s lost) | Lowest                                      | Lowest: `setInterval`          | Trivial     | Works everywhere                                                                      |
| B. Long polling           | Near zero                                          | Medium: track and time out pending requests | Low                            | Easy        | Works everywhere; a connection per user                                               |
| **C. Server-Sent Events** | Near zero                                          | Low: a streaming endpoint                   | Lowest: built-in `EventSource` | Built in    | Proxies that buffer can delay events; send no-buffer headers and test on Render early |
| D. WebSocket              | Near zero                                          | Highest: lifecycle, heartbeats, protocol    | Medium                         | Hand-rolled | Supported; overkill for one-way push                                                  |

#### How SSE fits the API

REST for commands, SSE for notifications, no message queue.

| Endpoint                       | Style        | Purpose                                                                                                 |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------- |
| `POST /api/sessions`           | REST command | Carrier picked: create a session and pre-warm its login page; returns a session ID (`429` at the cap)   |
| `POST /api/sessions/:id/login` | REST command | Submit username and password; checks for a saved session (fast path), otherwise logs in                 |
| `GET /api/sessions/:id/events` | SSE stream   | Pushes events such as `logging_in`, `mfa_required`, `fetching_docs`, `document_ready`, `done`, `failed` |
| `POST /api/sessions/:id/mfa`   | REST command | Submit the MFA code to the live session                                                                 |
| `GET /api/documents/:id`       | REST read    | Stream one PDF through the backend (lazy loading)                                                       |
| `DELETE /api/me`               | REST command | "Forget me": delete saved sessions                                                                      |

The login job runs in the same process as the API. It emits state changes on an in-memory event
emitter, and the SSE handler forwards them. The server keeps each job's latest state in memory, so
a reconnecting browser gets the current state immediately. If the container restarts mid-login,
that job is lost and the user starts again; a queue (e.g. Redis + BullMQ) is only worth it with a
separate worker pool.

### D9. Document delivery

| Option                                                       | Pros                                          | Cons                                                 |
| ------------------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------- |
| **A. Stream from the carrier on demand through the backend** | Nothing stored. Always current                | Needs a live session at view time. Slower to re-open |
| B. Download once, store encrypted, serve from there          | Fast re-open. Works after the session expires | PII at rest. Retention rules                         |
| **C. List first, fetch each PDF lazily on click**            | First content on screen fastest               | "Document on screen" may then mean the list          |

Picked C + A: list first, the first ID card fetched eagerly, the rest lazily, all streamed.

### D10. Browser lifecycle

| Option                                           | Pros                                        | Cons                                                         |
| ------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------ |
| A. Launch a browser per request                  | Clean isolation                             | Adds 1–3 s of cold start to every run                        |
| **B. Warm browser, a fresh context per session** | No cold start. Contexts isolate cookies     | Idle RAM cost. Contexts share some browser-level fingerprint |
| C. Persistent profile per user, kept warm        | Fastest repeat runs, strongest device trust | Most memory. Complex lifecycle                               |

### D11. Frontend

| Option                          | Pros                           | Cons                                        |
| ------------------------------- | ------------------------------ | ------------------------------------------- |
| A. Plain HTML + JS from the API | Least to build. One deployable | Messy if the UI grows                       |
| **B. React / Vite SPA**         | Familiar component model       | A build step and a second artifact          |
| C. Next.js                      | One framework                  | Serverless-leaning model clashes with D4/D5 |

## Architecture alternatives

The one-container monolith wins because it spends the least effort on everything except the hard
problem, anti-bot from the cloud. The interfaces keep a path open to the worker-pool design at
scale without a rewrite.

| #   | Architecture                                | How it works                                                                 | Pros                                                                | Cons                                                                                                |
| --- | ------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A   | **One-container modular monolith (picked)** | API, orchestration, browser and store in one process on one Render service   | Simplest to build, deploy and debug. Browser survives MFA. Cheapest | Single point of failure. One instance only (the disk enforces this). Restart loses in-flight logins |
| B   | API + browser worker pool + queue           | Stateless API queues login jobs (Redis + BullMQ); workers own browsers       | The production shape at scale                                       | 2–3 services plus Redis. Hard to finish well in 20 hours                                            |
| C   | Serverless API + managed remote browser     | Functions drive a vendor-hosted browser                                      | No servers; vendor handles stealth, IPs, scaling                    | Paid per session. Latency per command. Lock-in. "Bought the graded part"                            |
| D   | Pure HTTP, no browser                       | Reverse-engineer each carrier's login and document APIs                      | Fastest, tiny memory                                                | Sensor scripts make tokens only a real browser can produce. Weeks per carrier                       |
| E   | Automation in the user's own browser        | An extension or the user's device logs in and sends documents to the backend | Real home IP and fingerprint; anti-bot largely disappears           | Breaks the "backend handles the automation" requirement. Needs an install                           |
| F   | Workflow engine (Temporal)                  | Each login is a durable workflow with a step that waits for MFA              | Durable state, retries, visibility                                  | Heavy infrastructure for a 6-step flow. Still needs a live browser                                  |
| G   | Monolith + separate static frontend         | A, with React on a static site or CDN                                        | Edge caching. Independent frontend deploys                          | Cross-origin cookies, CORS and the access gate get harder                                           |

### Per-component alternatives (picked first)

- **API framework:** **Koa** (the framework I know best; minimal async middleware; add @koa/router,
  zod, koa-pino-logger, koa-ratelimit, koa-helmet; SSE set up by hand). Alternatives: Fastify
  (built-in validation and pino, new to learn), Express 5 (familiar, validation bolted on), NestJS
  (heavy boilerplate), Hono (thinner ecosystem for this).
- **Serving the UI:** **same server** (one origin: cookies, access gate and SSE just work).
  Alternatives: static site/CDN (CORS and cross-origin cookies), Next.js (fights the long-lived browser).
- **Session manager:** **hand-written pure state machine, in process.** Alternatives: XState
  (heavy for about 8 states), BullMQ (needs Redis; waiting for MFA is awkward), Temporal (big
  infrastructure), logic inline in route handlers (hard to test).
- **Carrier adapters:** **coded adapter per carrier behind one interface** (full control,
  deterministic, fixture-testable). Alternatives: declarative config (real portals outgrow it), AI
  browser agent (seconds per step blows 8 s), coded + AI fallback combo (stretch), recorded
  network replay (brittle against anti-bot tokens).
- **Anti-bot layer:** **in-house, 5 small interfaces, chosen per carrier in config.**
  Alternatives: one hard-coded approach (the next detection change means edits across adapters),
  fully outsourced vendor (cost, lock-in, less to show), separate anti-bot service (only at scale).
- **Browser:** **one warm browser, fresh context per session** (relaunch on crash).
  Alternatives: browser per request (+1–3 s), pool of N browsers (N × memory), persistent profile
  per user (most memory), remote browsers (latency or a bill).
- **Session store:** **encrypted SQLite on a Render disk.** Alternatives: memory only (lost per
  deploy), Render Key Value (free tier doesn't persist), Postgres (heavy), encrypted blob in the
  user's browser (can't revoke from the server).
- **Encryption key:** **Render env var** (simple; manual rotation). Alternative: cloud KMS.

### Performance: what matters for the 8 s budget

The framework doesn't matter for latency: Fastify, Express and Koa each add well under a
millisecond per request, so a full run costs under about 10 ms of 8,000 ms. The session manager
matters because it owns the critical path:

| Lever                                                                                                                   | Estimated saving                     | Tradeoff                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| Pre-warm on carrier pick                                                                                                | ~1.5 s on a first run                | A context held before credentials arrive counts toward the cap; closes after 2 min unused |
| Optimistic fast path: skip `isSessionValid`, request the document list directly; on rejection fall back to a full login | ~1 s on a repeat run (2.7 s → 1.7 s) | Slightly slower failure path when the saved session expired                               |
| Fetch the list and the first ID card in parallel                                                                        | up to 0.6 s                          | Depends on the portal's API                                                               |
| Don't wait for the session save; write it in the background                                                             | ~50–100 ms                           | A crash in that window loses the save; the next run logs in again                         |
| Push each event over SSE immediately, no batching                                                                       | 0.25–0.5 s vs polling                | Already decided (D8)                                                                      |
| At the cap, reject with 429 rather than queueing                                                                        | Avoids hidden waits                  | The user retries by hand                                                                  |

## AI agent adapters: cost, latency and a combo design

An AI agent login costs a few cents to about a dollar depending on the model and takes roughly
20–40 s, which rules it out for the 8 s path. It is viable as a slower fallback for carriers
without a coded adapter.

**Cost estimate.** About 12 model calls per run, each ~15k input and ~800 output tokens: ~180k
input and ~10k output per run, without prompt caching (Anthropic list prices, Nov 2026).

| Model             | Price in / out ($ per 1M tokens) | Per run | 20 runs | 100 runs |
| ----------------- | -------------------------------- | ------- | ------- | -------- |
| Claude Haiku 5.5  | 0.10 / 0.50                      | ~$0.02  | ~$0.50  | ~$2.30   |
| Claude Sonnet 5.5 | 2 / 10                           | ~$0.46  | ~$9     | ~$46     |
| Claude Opus 5.5   | 4 / 20                           | ~$0.92  | ~$18    | ~$92     |

Prompt caching cuts this further. Within "a few bucks", only Haiku fits more than a handful of
runs; compare models on the mock portal before touching a real one.

**Latency.** 12 steps × (1–3 s per model call + ~0.5 s page action) ≈ 18–40 s per run.

**The combo:** coded adapters first, an AI agent for everything else.

- **One interface.** An adapter registry maps each carrier to a coded adapter when one exists,
  otherwise a generic `AgentAdapter` implementing the same `CarrierAdapter` interface. Session
  manager, SSE, store and UI don't change.
- **Same anti-bot layer** for fingerprint, IP and pacing.
- **Credentials never reach the model.** Tools such as `fill_username`, `fill_password` and
  `submit_mfa_code` fill in real values; the model sees placeholders.
- **MFA through the normal flow** via a `request_mfa_code` tool.
- **Guardrails.** Navigation stays on the carrier's domain; maximum step count and overall
  timeout; tools limited to click, type, read and download; page text treated as untrusted; the
  two-failed-logins-a-day cap still applies.
- **Privacy.** Page content goes to the model provider: disclose it in the UI and README; send
  trimmed page text, not documents.
- **Graduation.** Each successful agent run's actions and selectors become the first draft of a
  coded adapter.
- **UI.** Carriers without a coded adapter appear as "Experimental (AI, about 30 s)" and need the
  portal URL.

**Recommendation:** build the seam now (adapter registry and interface; cheap). Build the
AgentAdapter only if time remains after both carriers work end to end and the production basics
are done; otherwise describe it in the README's next steps. **Decide by Nov 12, 2026.**

## Reviewer experience

Reviewers can run and judge everything without carrier credentials. A Demo carrier drives the full
flow against the mock portal; the two real carriers are proven by the Loom, the real timing logs
from Render, and any reviewer with their own account.

| Path                                      | Needs                                      | Shows                                                                                             |
| ----------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Run locally with the Demo carrier         | Docker; one command                        | The full flow: login, MFA prompt, ID card first, lazy load, session reuse on a second run, errors |
| Hosted URL with the Demo carrier          | The access code (sent with the submission) | The same, deployed on Render, with real latency over the internet                                 |
| Hosted URL with Progressive or carrier #2 | Their own account; MFA code to their phone | The real end-to-end flow, including anti-bot from a cloud IP                                      |
| Loom                                      | Nothing                                    | Both real carriers end to end, a repeat run on the fast path, a code walkthrough                  |
| Repo and CI                               | Nothing                                    | Tests, green CI, Dockerfile, render.yaml, the anti-bot write-up and timing tables                 |

**Demo carrier.** A normal `CarrierAdapter` pointed at the mock-portal package, so it exercises the
real session manager, anti-bot layer, SSE and document streaming. The README documents its MFA
code; special usernames trigger failure modes (wrong password, wrong code, blocked, slow portal).
Labeled "Demo carrier (test fixture)" and never counted as one of the two carriers. On by default
locally; controlled by `DEMO_CARRIER_ENABLED` on Render.

**Run locally:**

```sh
cp .env.example .env
docker compose up
```

Then open http://localhost:3000. `.env.example` ships safe local defaults; no real secrets needed.

### README outline

1. **What it is.** One paragraph and the architecture diagram.
2. **Quick start.** The two commands above; hosted URL and access code; the Demo carrier and its MFA code.
3. **Supported carriers.** Progressive and carrier #2, what each needs, the Loom link.
4. **Latency.** Measured time to first document, first and repeat run, per carrier, from Render, and how it's measured (Q6).
5. **Anti-bot and fingerprinting.** What we tried, what worked, tradeoffs: the spike-harness results table.
6. **Session reuse and reliability.** Fast path, TTL, failure classification.
7. **Security.** Never storing passwords, encryption, the access gate, what is and isn't logged.
8. **Production readiness.** Tests and how to run them, CI/CD, health and status endpoints, graceful shutdown.
9. **Limits and next steps.** One container, the self-hosted arms race, what changes at scale (worker pool, queue, vendor escape hatch).
10. **AI usage.** Links to the Claude sessions and any other tools used.
