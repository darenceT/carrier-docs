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

| Carrier     | Login                        | Documents                                                 | Status                                                                            |
| ----------- | ---------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Progressive | Username, password, SMS code | The app's own ID card request; one document per card page | Real logins through the deployed app passed (full login and saved session)        |
| Lemonade    | Email, then SMS code         | In-page API returns a PDF link per policy                 | Real login from Render passed (SMS code, policy PDF, repeat run on saved cookies) |

Loom walkthrough: _link to add_.

## Latency

**Target:** login to first document in under 8 s. **Where it stands:**

- **Returning browser (saved session, pre-warmed): met on both carriers.** Progressive 7.4 s,
  Lemonade 3.5 s, from submit to first document, with no password and no code.
- **First login with an SMS code: met on Lemonade** (7.2 s after the code), **not on
  Progressive** (13.4 s after the code, nearly all of it Progressive's own site).

### What is measured

- **Headline:** time from submitting the verification code until the first document is ready
  ("First document in X s after submitting the verification code"). The time the user spends
  reading and typing the code is not counted. A login without a code step counts from the start.
- **Where the numbers come from:** real logins through the deployed app on Render (Starter:
  0.5 CPU, 512 MB, Oregon), 2026-11-12. Each step is logged with its duration
  (`"component":"carrier"` lines); `GET /api/status` reports p50/p95 per carrier.
- **Sample size:** a handful of runs per path, by hand. Treat them as typical values, not
  percentiles.

### Measured

| Path                                           | Before the code | After the code  | Notes                                        |
| ---------------------------------------------- | --------------- | --------------- | -------------------------------------------- |
| Progressive, first login (password + SMS code) | 3.2 s           | 13.4 s          | Five runs: 13.4 to 14.7 s                    |
| Progressive, saved session, pre-warmed         | n/a             | **7.4 s** total | Submitted 6 s after picking the carrier      |
| Progressive, saved session, not pre-warmed     | n/a             | 14.0 s total    | Before the saved-session pre-warm existed    |
| Lemonade, first login (email + SMS code)       | 1.4 s           | **7.2 s**       | 13.3 s once, on a retry right after a deploy |
| Lemonade, saved session, pre-warmed            | n/a             | **3.5 s** total | Submitted 6.5 s after picking the carrier    |

Notes on reading these:

- **A pre-warmed run depends on the head start.** The server starts when the carrier is picked;
  both runs above had only about 6 s before submit. With more typing time the documents are
  ready at submit. With none, the run takes as long as "not pre-warmed".
- **Lemonade before the code: 1.4 s with the pre-warmed page** (the latest run; 5.6 s in an
  earlier one, before the login speed-ups). One run took 13.3 s: a deploy restarted the server
  while that login was waiting for its code, and the retry started with no pre-warm on a server
  that had just booted. The deploy also showed that the browser was closed at once on the
  shutdown signal, defeating the 25 s drain; fixed since, so logins in flight can finish.

### Where the time goes (Progressive, after the code: 13.5 s)

| Step                                          | Time        | Whose time                                        |
| --------------------------------------------- | ----------- | ------------------------------------------------- |
| Type the code, Progressive checks it          | 1.8 s       | Carrier request (0.6 s of it is our paced typing) |
| Redirect into the account                     | 0.9 s       | Carrier                                           |
| Account page starts and loads the policy list | 4.5 s       | Carrier's page, running in our browser on 0.5 CPU |
| "ID cards" link renders and is clicked        | 2.9 s       | Carrier's page, running in our browser on 0.5 CPU |
| Progressive's app fetches the ID card         | 2.5 to 3 s  | Carrier request                                   |
| Our own code between those steps              | under 0.5 s | Ours                                              |

Three kinds of time, and what moves each:

- **Carrier requests (about 5 s):** the carrier's servers answering. Nothing on our side
  changes this except doing the work earlier.
- **Carrier pages running on our CPU (about 7.4 s):** Progressive's account is a large
  single-page app, and we must let it run: its ID card request is the only one the API accepts
  (our own copy of that request is refused with a 401). This is the part more CPU would shorten.
  Evidence that the instance is CPU-bound rather than network-bound: the same login pages loaded
  faster from a home connection than from Render (Progressive 800 ms against 1,068 ms; Lemonade
  1,317 ms against 1,499 ms; docs/spike.md). How much a bigger instance would save is not
  measured.
- **Our code (about 1 s):** paced typing of the code (0.6 s) and what is left after the fixes
  below.

### What was fixed, with before and after

| Change                                                          | Before | After                      |
| --------------------------------------------------------------- | ------ | -------------------------- |
| Clicks that waited out a 30 s timeout in the code step          | 32 s   | 2.7 s                      |
| Password and email filled in one go; "send text" chosen at once | 5.9 s  | 3.2 s                      |
| Browser launched at boot, not on the first login                | 1.4 s  | 0                          |
| ID card shown page by page as sent; no PDF conversion           | 1.4 s  | 0                          |
| Session-timeout page recognised at once                         | 90 s   | under 3 s (a failure path) |

Tried and removed, because measurement said so:

- **Blocking images, fonts and trackers** on carrier pages: 284 requests blocked, no step got
  faster, and the card request took about 3 s longer in the one run. Off by default
  (`RESOURCE_BLOCKING`).
- **Going straight to the ID cards page:** its address carries the policy number, and jumping
  there while the app was starting made Progressive show its session-timeout page.

### What is free: doing the work before the user submits

- **Login page pre-warm.** Picking a carrier loads its login page while the user types.
- **Saved session.** After one login the session is kept encrypted for 7 days; a repeat run
  skips the password and the code (26.5 s end to end became 14.0 s on Progressive).
- **Saved-session pre-warm.** For a returning browser, picking the carrier opens the saved
  session, checks it and fetches the document list and first document ahead. They are released
  only when a login with the same username arrives. Measured on Render: Progressive 14.0 s
  became 7.4 s, and Lemonade took 3.5 s, each with about 6 s of head start.

### What would cost money

| Option                              | Expected effect                                           | Cost and risk                                                         |
| ----------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| Bigger Render instance (more CPU)   | Shortens the 7.4 s of page time; amount not measured      | Next plan up; not taken (budget)                                      |
| Region nearer the carriers' servers | Perhaps 0.5 to 1.5 s; a guess, the evidence points at CPU | New service, saved sessions lost, a new IP the carriers have not seen |
| More than one browser slot          | No single-login gain; removes the queue under concurrency | 512 MB fits one session (docs/spike.md)                               |

### Why a first Progressive login cannot reach 8 s here

Progressive's own steps after the code add up to about 13 s on this instance, and about 5 s of
that is their servers answering, which no hosting change removes. The target is met where the
work can start early: the pre-warmed saved session (7.4 s).

One lever is still open for the first login: asking for the ID card with our own request as
soon as the policy list arrives, instead of waiting for the "ID cards" link and the page's own
request (about 5 s together). Our earlier copy of that request was refused; a real login showed
it had dropped the app's `api_key` header. Whether Progressive accepts it with the key is being
checked; if so, the estimate is about 3 s saved.

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
- **Saved-session pre-warm.** For a returning browser, picking the carrier already opens the
  saved session and fetches the documents ahead; they are released only to a login with the same
  username (see Latency).
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

Built with Claude Code. Session links:

- https://claude.ai/code/cshk_01HV3KES5vmmw9npnJZV3RoxKKAiHRhM2znikyhZwCT3ZT
- https://claude.ai/code/cshk_01HV3KERTrchFSBrvqfu4Mz5UcbB6aPTUe3JTbX83TDHmc
