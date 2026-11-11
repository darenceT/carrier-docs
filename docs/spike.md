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

Home findings (2026-11-11):

- No page blocked or challenged on load, with any strategy, including Progressive's login page.
- Stock strategies report `navigator.webdriver = true`; patchright reports `false`. This is the
  first fingerprint difference between the options and supports patched headless for D2.
- "Clean" means no block page, challenge text or CAPTCHA frame on load. It does not mean the
  bot-check pages passed every test (see their screenshots in `spike-results/screens/`), and it
  does not prove a login will pass: anti-bot scoring usually happens on form submit. The real
  login from Render settles that.
- The 3414 ms on the first row is the run's first page load (cold start).

Render findings (2026-11-11):

- Patched headless loads Progressive's login page clean from Render's IP (HTTP 200, no block or
  challenge, `webdriver = false`), so there is no IP block on page load. The real login settles
  whether the IP is accepted on submit.
- Stock strategies weren't run on Render: `playwright` is a dev dependency and isn't in the
  production image. Not needed for the decision; the home runs already compare them.
- The harness's per-process memory (583-734 MB) overcounts, because Chromium processes share
  memory. Use the container's cgroup counters for the memory table instead.

### Memory on Render (Starter, 512 MB)

| Contexts open | Container MB (cgroup)                    | Source                                      |
| ------------- | ---------------------------------------- | ------------------------------------------- |
| 0 (idle app)  | 36 (`memory.current`)                    | Shell, 2026-11-11, no browser running       |
| 1             | 388 peak (`memory.peak`, includes cache) | Shell, after the patched-headless spike run |
| 2 or 3        | over 512: out-of-memory kill             | Render event "Ran out of memory", 05:45 UTC |

The first memory run opened contexts one by one without a safety stop and the instance was
killed partway ("Instance failed: ran out of memory (used over 512MB)"; it recovered on its own).
Its output was lost with the Shell session, so the exact count it reached is unknown. The harness
now reads cgroup counters, stops at 85% of the limit and logs each step (#17); re-run with
`--max-contexts=2` to fill in the per-context split.

Conclusion so far: one session peaks near 390 MB, so on Starter only **1** session fits under the
~410 MB line. Two or more need a larger plan.

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
