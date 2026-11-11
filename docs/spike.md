# Phase 2 spike: runbook and results

The spike answers the riskiest question first: does a Progressive login get through from
Render's IP, and with which browser setup? It also measures memory per session to set
`MAX_SESSIONS`. Fill in the results below as you go; they feed D1–D3 in `docs/design.md`
and the README's anti-bot section.

## The harness

`apps/server/src/scripts/spike.ts` loads bot-check pages and carrier **login pages** with
each strategy and records status, verdict (clean / challenge / blocked / error), the matched
markers, `navigator.webdriver`, timings and browser memory. It never fills or submits a form,
so it can't lock an account or use an MFA code.

Strategies (`SPIKE_STRATEGIES`, comma-separated):

| Strategy             | Design option | What it is                                          |
| -------------------- | ------------- | --------------------------------------------------- |
| `stock-headless`     | A             | Stock Playwright headless shell                     |
| `stock-new-headless` | B (baseline)  | Stock Playwright full Chromium in new headless mode |
| `patched-headless`   | C (first try) | patchright, headless                                |

`playwright` (1.64.1) and `patchright` (1.64.3) are pinned to share one Chromium build, so the
image installs the browser once.

### Run locally (home IP)

```sh
npm run spike --                                  # bot-check pages only
npm run spike -- https://<progressive-login-url>  # plus the login page
npm run spike -- --memory https://<progressive-login-url>
```

Results go to `spike-results/` (git-ignored). The memory column is `n/a` on Windows.

### Run on Render (Render's IP)

Open the service's **Shell** tab and run:

```sh
node apps/server/dist/scripts/spike.js https://<progressive-login-url>
node apps/server/dist/scripts/spike.js --memory https://<progressive-login-url>
```

Results go to `/tmp/spike-results` (the app directory isn't writable there). Copy the printed
table into the results below.

Reading the comparison: clean at home but challenged on Render is an **IP problem** (D3);
challenged in both places is a **fingerprint problem** (D2).

## Results

Fill in with measured values, never targets. No credentials, policy numbers or names here.

### Bot-check and login-page loads

| Date       | Where  | Strategy           | Target            | Verdict | Status | webdriver | DCL ms | Markers                                  |
| ---------- | ------ | ------------------ | ----------------- | ------- | ------ | --------- | ------ | ---------------------------------------- |
| 2026-11-11 | home   | stock-headless     | sannysoft         | clean   | 200    | true      | 3414   |                                          |
| 2026-11-11 | home   | stock-new-headless | sannysoft         | clean   | 200    | true      | 812    |                                          |
| 2026-11-11 | home   | patched-headless   | sannysoft         | clean   | 200    | false     | 874    |                                          |
| 2026-11-11 | home   | stock-headless     | CreepJS           | clean   | 200    | true      | 533    |                                          |
| 2026-11-11 | home   | stock-new-headless | CreepJS           | clean   | 200    | true      | 338    |                                          |
| 2026-11-11 | home   | patched-headless   | CreepJS           | clean   | 200    | false     | 424    |                                          |
| 2026-11-11 | home   | stock-headless     | Progressive login | clean   | 200    | true      | 790    |                                          |
| 2026-11-11 | home   | stock-new-headless | Progressive login | clean   | 200    | true      | 753    |                                          |
| 2026-11-11 | home   | patched-headless   | Progressive login | clean   | 200    | false     | 800    |                                          |
| 2026-11-11 | Render | stock-headless     | all               | not run | —      | —         | —      | Playwright isn't in the production image |
| 2026-11-11 | Render | stock-new-headless | all               | not run | —      | —         | —      | Playwright isn't in the production image |
| 2026-11-11 | Render | patched-headless   | sannysoft         | clean   | 200    | false     | 983    |                                          |
| 2026-11-11 | Render | patched-headless   | CreepJS           | clean   | 200    | false     | 410    |                                          |
| 2026-11-11 | Render | patched-headless   | Progressive login | clean   | 200    | false     | 1068   |                                          |
| 2026-11-11 | home   | stock-headless     | Lemonade login    | clean   | 200    | true      | 1317   |                                          |
| 2026-11-11 | home   | stock-new-headless | Lemonade login    | clean   | 200    | true      | 1335   |                                          |
| 2026-11-11 | home   | patched-headless   | Lemonade login    | clean   | 200    | false     | 1302   |                                          |
| 2026-11-11 | Render | patched-headless   | Lemonade login    | clean   | 200    | false     | 1499   |                                          |

Home findings (2026-11-11):

- No page blocked or challenged on load, with any strategy, including Progressive's login page.
- Stock strategies report `navigator.webdriver = true`; patchright reports `false`. This is the
  first fingerprint difference between the options and supports patched headless for D2.
- "Clean" means no block page, challenge text or CAPTCHA frame on load. It does not mean the
  bot-check pages passed every test (see their screenshots in `spike-results/screens/`), and it
  does not prove a login will pass: anti-bot scoring usually happens on form submit. The real
  login from Render settles that.
- The 3414 ms on the first row is the run's first page load (cold start).

Lemonade findings (2026-11-11, login page `https://www.lemonade.com/login#email`):

- Clean at home with all three strategies and from Render with patched headless (HTTP 200, no
  block or challenge). Same `webdriver` pattern as Progressive: stock `true`, patched `false`.
- Memory on Render, one context on Lemonade's login page: container 217 MB before, 300 MB after
  (+83 MB), versus +183 MB for Progressive's. Progressive is the limiting case for `MAX_SESSIONS`.
- The bot-check rows from these runs match the earlier ones and aren't repeated.
- Lemonade runs Cloudflare bot detection (see the Lemonade mapping), so "clean on load" matters
  less here than the real login.

Render findings (2026-11-11):

- Patched headless loads Progressive's login page clean from Render's IP (HTTP 200, no block or
  challenge, `webdriver = false`), so there is no IP block on page load. The real login settles
  whether the IP is accepted on submit.
- Stock strategies weren't run on Render: `playwright` is a dev dependency and isn't in the
  production image. Not needed for the decision; the home runs already compare them.
- The harness's per-process memory (583-734 MB) overcounts, because Chromium processes share
  memory. Use the container's cgroup counters for the memory table instead.

### Memory on Render (Starter, 512 MB)

| Contexts open  | Container MB (cgroup) | Program MB | Cache MB | Step change |
| -------------- | --------------------- | ---------- | -------- | ----------- |
| 0 (browser up) | 137                   | 126        | 1        |             |
| 1              | 320                   | 279        | 28       | +183        |
| 2              | 481 (94% of 512)      | 420        | 45       | +161        |

Measured 2026-11-11 with `--memory --max-contexts=2` on the Progressive login page, patched
headless, after #17 (cgroup counters, 85% safety stop, step log). Includes the spike script's own
Node process (about 111 MB RSS), which the real server doesn't run.

An earlier run without the safety stop opened more contexts and got the instance killed ("Ran out
of memory (used over 512MB)", 05:45 UTC); it recovered on its own.

Conclusion: each session costs about 160-185 MB, almost all program memory. Two sessions reach
94% of the Starter limit, past the ~410 MB line, and real sessions (login, documents, PDFs) use
more than a login page. **`MAX_SESSIONS` = 1 on Starter.** A larger plan fits roughly
(80% of its memory - 140 MB) / 170 MB sessions.

### Real login from Render (one attempt, counts against 2 failed logins a day)

| Date | Carrier     | Outcome | Login page ms | Credentials → MFA ms | MFA → logged in ms | Notes |
| ---- | ----------- | ------- | ------------- | -------------------- | ------------------ | ----- |
|      | Progressive |         |               |                      |                    |       |

### Portal mapping

#### Progressive (from a `playwright codegen --save-har` login at home, 2026-11-11)

Read from the HAR's structure only (URL patterns, field names, status values); no credentials,
tokens or policy data were copied. The raw HAR stays in git-ignored `fixtures/raw/`.

- **Login is PingFederate's authentication API** (`login.progressive.com/pf-ws/authn/flows/<id>`),
  driven by the page with JSON POSTs and an `X-XSRF-Header`. Status sequence:

  | Step | Request                                                      | Resulting `status`           |
  | ---- | ------------------------------------------------------------ | ---------------------------- |
  | 1    | `GET` the flow                                               | `CREDENTIALS_REQUIRED`       |
  | 2    | `POST ?action=checkUsernamePassword`                         | `AUTHENTICATION_REQUIRED`    |
  | 3    | `POST ?action=authenticate` (picks the SMS device)           | `OTP_REQUIRED`               |
  | 4    | `POST ?action=checkOtp` body `{ otp }`                       | `MFA_COMPLETED`              |
  | 5    | `POST ?action=continueAuthentication`                        | `DEVICE_PROPERTIES_REQUIRED` |
  | 6    | `POST ?action=setDeviceProperties` body `{ rememberDevice }` | resumes the OAuth flow       |
  | 7    | `GET /as/<id>/resume/as/authorization.ping`, then `/as/<id>` | `COMPLETED`                  |

  "Remember this device" is step 6 and sets the long-lived `pgrDevice_<uuid>` cookie (expires
  ~13 months out), so later logins should skip steps 3-4 (the SMS).

- **API auth:** `api.progressive.com/policypro/...` calls send `Authorization: Bearer <token>` (plus
  several `x-prg*`/`x-pgr*` headers), not cookies. `GET /policypro/v1/handshake` opens the account
  session and lists policies.
- **Document list:** `GET https://api.progressive.com/policypro/v1/account/documents?listType=Terms`
  returns JSON `accountDocuments[]` (per policy: `documents`, `terms[].documentType`, `actions[]`
  with `serviceEndpointUrl`).
- **The document itself, no separate download:** `POST https://api.progressive.com/policypro/v1/policies/<id>/document?policyInfoKey=<key>`
  with JSON `{ type, mimeType, format, dpi, policyTerm, replacementVehicles }` returns
  `{ message, signature, documents[] }`, where `documents` are base64 files. With
  `type: idCard, mimeType: pdf` it returns one PDF (~116 KB); with `mimeType: png` it returns four
  PNG images (the on-page viewer). That's why "Download" shows no network request: the PDF is
  already in the page.
- **Cookies:** `pgrDevice_<uuid>` (device trust, 2027-12-16), `PF` (PingFederate session, browser
  close), `SITESERVER` (routing). `ADRUM` (AppDynamics), `QuantumMetric*` (analytics) and
  `PgrOptOutPref` aren't login-related. No bot-manager cookies or scripts (Akamai, HUMAN,
  Cloudflare, DataDome, Imperva, Kasada) appeared; the third-party hosts were analytics, ads and
  monitoring.
- **Where the token lives:** not in storage. Storage holds only `ADRUM_*` (AppDynamics),
  `QM_*`/`QEventChannel` (analytics) and display preferences (`colorTheme`, `sizeTheme`,
  `defaultLanguageCode`, `preferredName`). The page keeps the Bearer token in memory and gets a
  fresh one silently from PingFederate (the HAR shows a second `GET /as/<id>` reaching
  `COMPLETED` later with no credentials), using PingFederate's `PF` session cookie.
- **Repeat runs:** saved browser state includes `PF` (browser-close cookies are kept), so within
  `PF`'s lifetime a repeat run should get a token silently and skip both password and SMS. After
  `PF` expires, the user retypes the password and `pgrDevice_<uuid>` should still skip the SMS.
  `PF`'s actual lifetime is measured in the real runs.

**D1 for Progressive:** after login, call the documents API from inside the page (the page's own
token is then sent), then `POST .../document` with `type: idCard, mimeType: pdf` and decode the
base64 PDF. Two API calls to the first ID card, no page navigation.

#### Lemonade (by hand in DevTools while logged in, 2026-11-11)

- **Login (from a codegen HAR, 2026-11-11; structure only, no values copied):** two JSON calls on
  `www.lemonade.com`, each sending an `x-csrf-token` header (from the `_csrf` cookie):

  | Step | Request                                                | Response                                                |
  | ---- | ------------------------------------------------------ | ------------------------------------------------------- |
  | 1    | `POST /login/presign` `{ email, preferred_channel }`   | `{ publicId, channel, digits, usedContact }` (SMS sent) |
  | 2    | `POST /login/signin` `{ code, consentReceived }` (201) | `{ redirectTo }`, then the app on `me.lemonade.com`     |

  No "remember this device" step exists, so every fresh login needs a new SMS code from the
  lender; repeat runs depend on the saved cookies staying valid.

- **Login cookies set:** `customer_session(.sig)` and related `customer_interaction*` cookies on
  `.lemonade.com` (HttpOnly, Secure), `_lmnd_shared_auth` (HttpOnly, Secure, long-lived) and
  `connect.sid` on `me.lemonade.com`, `_lmnd_users_edge_session` on `my.lemonade.com`. Local storage
  holds only analytics and ad keys (Taboola, mParticle, Google, Snap), so the login is cookie-based:
  saved browser state captures it fully. API calls on `my.lemonade.com` send cookies plus
  `x-csrf-token`.
- **Domains:** `me.lemonade.com` (web app), `my.lemonade.com` (JSON API), `icebox.lemonade.com`
  (document downloads).
- **Landing page after login:** `https://me.lemonade.com/` (plus a `resetHash` query string).
- **Policy list and document links, one call:** `GET https://my.lemonade.com/api/v1/web_dashboard/accounts/home/policies`
  returns JSON; `data.items` is keyed by policy ID (one entry per insured address, two on this
  account), and each item's `form_url` is that policy's PDF link.
- **Policy page (UI only):** `https://me.lemonade.com/policy/<id>`, opened in a new tab from the
  address dropdown. The automation skips it and uses the API call above.
- **Documents:** one per policy, the policy PDF ("download a copy of your policy"). Renters has no
  ID card, so this PDF is the first document shown.
- **PDF download:** `https://icebox.lemonade.com/tokens/<token>`. The token is a bearer credential:
  the link downloaded the PDF in a private window with no cookies, and a new token is issued on
  every page load (so they are likely short-lived). Treat `form_url` as a secret: never log or
  store it, fetch it only to stream the PDF.
- **Login cookies** (names and expiry only, read 2026-11-11):

  | Cookie                                     | Likely role                                        | Expires                          |
  | ------------------------------------------ | -------------------------------------------------- | -------------------------------- |
  | `customer_session`, `customer_session.sig` | Signed long-lived login (Express `cookie-session`) | 2027-01-10 (about 60 days)       |
  | `connect.sid`                              | Express server-side session ID                     | 2026-11-12 19:07 UTC (~1.5 days) |
  | `_lmnd_users_edge_session`                 | Edge/CDN session                                   | Browser close                    |

  Saved browser state includes all of these, browser-close cookies too. Whether reuse lasts ~60
  days or ~1 day depends on which cookie the server requires. Test without code or the lender:
  after 2026-11-12 19:07 UTC, open `https://me.lemonade.com/` in the same browser and note whether
  it is still logged in.

- **Anti-bot: Cloudflare bot detection is on.** The HAR shows Cloudflare's JavaScript detection
  (`POST /cdn-cgi/challenge-platform/h/b/precursor/...`) on both `www.lemonade.com` and
  `me.lemonade.com`, and Cloudflare's `cf_clearance` cookie (HttpOnly) being set on both. It was
  missed in the cookie list read by hand earlier. The DataDome cookie seen there belongs to Taboola,
  an embedded ad network, not Lemonade. Login pages loaded clean from Render with patched headless,
  but Cloudflare can still challenge on submit; the real login from Render settles it, and the
  headed fallback (D2-D) is the first response if it does.

**D1 for Lemonade:** no page navigation needed after login. Call the policies API from inside the
logged-in page, then fetch each `form_url` and stream the PDF. Two requests to the first document,
which is good for the 8 s budget.

## Decisions

| Decision                                | Result                                                                                                                                 | Evidence                                                                                                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 Automation (in-page document fetch?) | Yes for both. Progressive: in-page API calls, PDF returned as base64 in JSON. Lemonade: one in-page API call, then the bearer PDF link | Progressive: `POST api.progressive.com/policypro/v1/policies/<id>/document` returns the ID card PDF in `documents[]`. Lemonade: `GET my.lemonade.com/api/v1/web_dashboard/accounts/home/policies` returns `form_url` per policy, which downloads with no cookies |
| D2 Browser (`PROGRESSIVE_BROWSER`)      |                                                                                                                                        |                                                                                                                                                                                                                                                                  |
| D3 Egress (direct or proxy)             |                                                                                                                                        |                                                                                                                                                                                                                                                                  |
| `MAX_SESSIONS`                          | 1 on Starter (512 MB); no plan upgrade (decided)                                                                                       | 1 session = 320 MB, 2 = 481 MB (94%) in the Render container; an over-limit run was OOM-killed                                                                                                                                                                   |
