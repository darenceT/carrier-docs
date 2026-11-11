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

#### Progressive (from `playwright codegen --save-har`, at home)

- Document list call (method, path pattern, response type):
- PDF download URL pattern:
- Can documents be fetched with in-page `fetch`? (decides D1):

#### Lemonade (by hand in DevTools while logged in, 2026-11-11)

- **Login:** email only, then an SMS code to the account holder's phone. Code-page URL and form
  field names to capture in the scheduled codegen login (submitting the email texts the lender).
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

- **Anti-bot:** no commercial bot manager found on Lemonade's own domains. The only bot-manager
  cookie seen was `datadome` on `.taboola.com` (Taboola, an embedded ad network, protecting its
  own servers). Checked 2026-11-11: no `datadome` cookie on `me.lemonade.com` or
  `my.lemonade.com`, and no requests from Lemonade's pages to `js.datadome.co` /
  `api-js.datadome.co`. No other common bot-manager cookies either (Akamai `_abck`/`bm_sz`, HUMAN
  `_px*`, Cloudflare `__cf_bm`, Imperva `incap_ses_*`/`reese84`, Kasada). Lemonade may still rate
  limit or score logins server-side; the real login from Render settles it.

**D1 for Lemonade:** no page navigation needed after login. Call the policies API from inside the
logged-in page, then fetch each `form_url` and stream the PDF. Two requests to the first document,
which is good for the 8 s budget.

## Decisions

| Decision                                | Result                                                                                          | Evidence                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 Automation (in-page document fetch?) | Lemonade: yes, one in-page API call, then the bearer PDF link. Progressive: pending its mapping | Lemonade: `GET my.lemonade.com/api/v1/web_dashboard/accounts/home/policies` returns `form_url` per policy; the link downloads with no cookies |
| D2 Browser (`PROGRESSIVE_BROWSER`)      |                                                                                                 |                                                                                                                                               |
| D3 Egress (direct or proxy)             |                                                                                                 |                                                                                                                                               |
| `MAX_SESSIONS`                          | 1 on Starter (512 MB); no plan upgrade (decided)                                                | 1 session = 320 MB, 2 = 481 MB (94%) in the Render container; an over-limit run was OOM-killed                                                |
