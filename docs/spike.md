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

| Date | Where  | Strategy           | Target            | Verdict | Status | webdriver | DCL ms | Markers |
| ---- | ------ | ------------------ | ----------------- | ------- | ------ | --------- | ------ | ------- |
|      | home   | stock-headless     | sannysoft         |         |        |           |        |         |
|      | home   | stock-new-headless | sannysoft         |         |        |           |        |         |
|      | home   | patched-headless   | sannysoft         |         |        |           |        |         |
|      | home   | patched-headless   | Progressive login |         |        |           |        |         |
|      | Render | stock-headless     | Progressive login |         |        |           |        |         |
|      | Render | stock-new-headless | Progressive login |         |        |           |        |         |
|      | Render | patched-headless   | Progressive login |         |        |           |        |         |

### Memory on Render (Starter, 512 MB)

| Contexts open | Browser MB | Node MB | Total MB |
| ------------- | ---------- | ------- | -------- |
| 0 (idle)      |            |         |          |
| 1             |            |         |          |
| 2             |            |         |          |
| 3             |            |         |          |

`MAX_SESSIONS` = the largest count whose total stays under ~410 MB (512 MB with 20% headroom).
If that's under 2, decide whether to move up a plan for the review days.

### Real login from Render (one attempt, counts against 2 failed logins a day)

| Date | Carrier     | Outcome | Login page ms | Credentials → MFA ms | MFA → logged in ms | Notes |
| ---- | ----------- | ------- | ------------- | -------------------- | ------------------ | ----- |
|      | Progressive |         |               |                      |                    |       |

### Portal mapping (from `playwright codegen --save-har`, at home)

- Document list call (method, path pattern, response type):
- PDF download URL pattern:
- Can documents be fetched with in-page `fetch`? (decides D1):

## Decisions

| Decision                                | Result | Evidence |
| --------------------------------------- | ------ | -------- |
| D1 Automation (in-page document fetch?) |        |          |
| D2 Browser (`PROGRESSIVE_BROWSER`)      |        |          |
| D3 Egress (direct or proxy)             |        |          |
| `MAX_SESSIONS`                          |        |          |
