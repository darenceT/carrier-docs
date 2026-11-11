/**
 * One real carrier login, run by a HUMAN only (CLAUDE.md hard rule 2). Phase 2, step 4.
 *
 * Drives the carrier's own login page with the same browser setup the server will use, asks you for
 * credentials and the SMS code in the terminal (typing is hidden), and prints only the outcome and
 * the time per step. It never prints credentials, codes, cookies, tokens, page content or documents.
 * It makes ONE attempt and never retries, so it can't lock an account.
 *
 * After a successful login it repeats the visit with the saved browser state in a fresh context
 * (kept in memory only) to measure whether a repeat run skips the login.
 *
 * Usage:
 *   npm run live-login -- progressive            (local)
 *   node apps/server/dist/scripts/live-login.js lemonade     (Render Shell)
 * Options:
 *   --headed       run a visible browser (needs a display, e.g. xvfb-run on Render)
 *   --no-reuse     skip the repeat-run check
 * Env:
 *   BROWSER_EXECUTABLE_PATH   optional: launch this browser binary instead of the bundled one
 */
import { chromium, type BrowserContext, type Locator, type Page, type Response } from 'patchright';
import {
  StepTimer,
  detectBlock,
  formatSteps,
  isPdf,
  looksLikeBadCredentials,
  maskUrl,
  type Outcome,
} from './live/helpers.js';
import { ask } from './live/prompt.js';
import { describeFields, findVisible, type FieldQuery } from './live/fields.js';

const CONTEXT_OPTIONS = {
  locale: 'en-US',
  timezoneId: 'America/Los_Angeles',
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
} as const;

const STEP_TIMEOUT_MS = 30_000;
const HUMAN_TIMEOUT_MS = 5 * 60_000;

/** Ends the run with an outcome. Thrown from deep inside a flow, caught in main(). */
class Stop extends Error {
  constructor(
    readonly outcome: Outcome,
    readonly detail: string,
  ) {
    super(detail);
  }
}

// ---------- terminal input (hidden) ----------

// ---------- page helpers ----------

async function pageText(page: Page): Promise<string> {
  return (
    (await page
      .locator('body')
      .innerText({ timeout: 3_000 })
      .catch(() => '')) ?? ''
  );
}

/** Throws Stop if the page is a block page or challenge. */
async function assertNotBlocked(page: Page, where: string): Promise<void> {
  const verdict = detectBlock(
    await pageText(page),
    page.frames().map((f) => f.url()),
  );
  if (verdict) throw new Stop(verdict, `${where}: ${maskUrl(page.url())}`);
}

/** The first visible field matching the query, on the page or in any frame. */
async function firstVisible(page: Page, what: string, q: FieldQuery): Promise<Locator> {
  const started = Date.now();
  const deadline = started + STEP_TIMEOUT_MS;
  let nextNote = started + 10_000;
  while (Date.now() < deadline) {
    const found = await findVisible(page, q);
    if (found) return found;
    await assertNotBlocked(page, `waiting for ${what}`);
    if (Date.now() >= nextNote) {
      console.log(`  still looking for ${what} (${Math.round((Date.now() - started) / 1000)} s)`);
      nextNote += 10_000;
    }
    await page.waitForTimeout(250);
  }
  console.log(`\nVisible form fields (attributes only, no values):\n${await describeFields(page)}`);
  throw new Stop('CARRIER_PAGE_CHANGED', `couldn't find ${what} on ${maskUrl(page.url())}`);
}

async function clickButton(page: Page, name: RegExp, what: string): Promise<void> {
  const button = page.getByRole('button', { name }).first();
  if (!(await button.isVisible().catch(() => false))) {
    throw new Stop(
      'CARRIER_PAGE_CHANGED',
      `couldn't find the ${what} button on ${maskUrl(page.url())}`,
    );
  }
  await button.click();
}

/** Waits for a response matching `test`, or a block page, whichever comes first. */
async function waitForResponseOrBlock(
  page: Page,
  test: (r: Response) => boolean,
  what: string,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<Response> {
  const response = page.waitForResponse(test, { timeout: timeoutMs }).catch(() => null);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await Promise.race([response, page.waitForTimeout(500).then(() => undefined)]);
    if (r) return r;
    if (r === null) break;
    await assertNotBlocked(page, `waiting for ${what}`);
  }
  await assertNotBlocked(page, `waiting for ${what}`);
  throw new Stop('CARRIER_PAGE_CHANGED', `no ${what} within ${timeoutMs / 1000} s`);
}

async function enterCode(page: Page, code: string): Promise<void> {
  const field = await firstVisible(page, 'the code field', {
    css: [
      'input[autocomplete="one-time-code"]',
      'input[name*="otp" i]',
      'input[name*="code" i]',
      'input[id*="code" i]',
      'input[inputmode="numeric"]',
      'input[type="tel"]',
    ],
    label: /code|passcode|verification/i,
  });
  await field.click();
  // Typing (not fill) also works for one-box-per-digit inputs that auto-advance.
  await page.keyboard.type(code, { delay: 60 });
}

// ---------- Progressive ----------

const PROGRESSIVE_LOGIN =
  'https://account.apps.progressive.com/access/login?cntgrp=A&fd=accountHome';
const isPfFlow = (r: Response) => r.url().includes('login.progressive.com/pf-ws/authn/flows');
const isHandshake = (r: Response) =>
  r.url().includes('api.progressive.com/policypro/') && r.url().includes('/handshake');

/** The PingFederate flow status from a pf-ws response (an enum like OTP_REQUIRED), or undefined. */
async function pfStatus(r: Response): Promise<string | undefined> {
  const body = (await r.json().catch(() => undefined)) as { status?: unknown } | undefined;
  return typeof body?.status === 'string' && /^[A-Z_]{3,40}$/.test(body.status)
    ? body.status
    : undefined;
}

/**
 * Records every PingFederate flow status and whether the account API has answered, from the moment
 * the page opens, so a step that completes before we start waiting for it is never missed.
 */
function trackProgressive(page: Page) {
  const statuses: string[] = [];
  let loggedIn = false;
  page.on('response', (r) => {
    if (isHandshake(r) && r.ok()) loggedIn = true;
    if (!isPfFlow(r)) return;
    void pfStatus(r).then((s) => {
      if (s) {
        statuses.push(s);
        console.log(`  flow status: ${s}`);
      }
    });
  });
  return {
    get loggedIn() {
      return loggedIn;
    },
    latest: () => statuses.at(-1),
    has: (s: string) => statuses.includes(s),
  };
}

/** Polls until `done()` returns a value, checking for block pages; null on timeout. */
async function poll<T>(
  page: Page,
  done: () => T | undefined,
  what: string,
  timeoutMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = done();
    if (v !== undefined) return v;
    await assertNotBlocked(page, `waiting for ${what}`);
    await page.waitForTimeout(300);
  }
  return null;
}

async function progressive(page: Page, timer: StepTimer): Promise<void> {
  const pf = trackProgressive(page);
  await page.goto(PROGRESSIVE_LOGIN, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_MS });
  const username = await firstVisible(page, 'the username field', {
    css: [
      'input[autocomplete="username"]',
      'input[name*="user" i]',
      'input[id*="user" i]',
      'input[name*="login" i]',
      'input[id*="login" i]',
      'input[type="email"]',
    ],
    label: /user ?(name|id)|log ?in id|email/i,
  });
  const password = await firstVisible(page, 'the password field', {
    css: ['input[type="password"]'],
    label: /password/i,
  });
  timer.mark('login page ready');

  const user = await ask('Progressive username:');
  const pass = await ask('Progressive password:');
  timer.skip();
  await username.fill(user);
  await password.fill(pass);
  const checked = waitForResponseOrBlock(
    page,
    (r) => isPfFlow(r) && r.url().includes('action=checkUsernamePassword'),
    'the password check',
  );
  await clickButton(page, /sign in|log ?in|continue/i, 'sign-in');
  const checkResponse = await checked;
  if (checkResponse.status() >= 400 || looksLikeBadCredentials(await pageText(page))) {
    throw new Stop('BAD_CREDENTIALS', `password check returned HTTP ${checkResponse.status()}`);
  }
  timer.mark('credentials accepted');

  // Next: the SMS step, or straight into the account if the device is remembered. Some versions
  // first ask how to send the code; if the flow sits still for 3 s, choose text/SMS once.
  let chose = false;
  const startedWaiting = Date.now();
  const next = await poll(
    page,
    () => {
      if (pf.has('OTP_REQUIRED')) return 'otp' as const;
      if (pf.loggedIn) return 'in' as const;
      if (!chose && Date.now() - startedWaiting > 3_000) {
        chose = true;
        void page
          .getByRole('button', { name: /text|send( a)? code|sms/i })
          .first()
          .click({ timeout: 2_000 })
          .then(() => console.log('  chose "text me a code"'))
          .catch(() => undefined);
      }
      return undefined;
    },
    'the SMS step',
    STEP_TIMEOUT_MS,
  );
  if (next === null) {
    throw new Stop(
      'CARRIER_PAGE_CHANGED',
      `no SMS step and no account page (last status ${pf.latest() ?? 'none'})`,
    );
  }
  timer.mark(next === 'otp' ? 'SMS step reached' : 'logged in (device remembered, no SMS)');
  if (next === 'in') return;

  const code = await ask('SMS code from your phone:');
  timer.skip();
  await enterCode(page, code);
  await clickButton(page, /verify|submit|continue|sign in/i, 'verify-code').catch(() =>
    page.keyboard.press('Enter'),
  );
  const otp = await poll(
    page,
    () => (pf.has('MFA_COMPLETED') ? 'ok' : pf.latest() === 'MFA_FAILED' ? 'bad' : undefined),
    'the code check',
    STEP_TIMEOUT_MS,
  );
  if (otp !== 'ok')
    throw new Stop(
      'MFA_INVALID',
      `the code was not accepted (last status ${pf.latest() ?? 'none'})`,
    );
  timer.mark('code accepted');

  // "Remember this device": a checkbox plus continue, or a dedicated button.
  const remember = page.getByRole('checkbox', { name: /remember|trust/i }).first();
  const rememberButton = page.getByRole('button', { name: /remember|trust|yes/i }).first();
  await Promise.race([
    remember.waitFor({ state: 'visible', timeout: 10_000 }),
    rememberButton.waitFor({ state: 'visible', timeout: 10_000 }),
  ]).catch(() => undefined);
  if (await remember.isVisible().catch(() => false)) {
    await remember.check();
    await clickButton(page, /continue|submit|done|next/i, 'continue');
    console.log('  remember this device: ticked');
  } else if (await rememberButton.isVisible().catch(() => false)) {
    await rememberButton.click();
    console.log('  remember this device: chosen');
  } else {
    console.log('  remember this device: not offered on screen');
  }

  const inAccount = await poll(
    page,
    () => (pf.loggedIn ? true : undefined),
    'the account API',
    STEP_TIMEOUT_MS,
  );
  if (!inAccount)
    throw new Stop(
      'CARRIER_PAGE_CHANGED',
      `account API didn't answer (last status ${pf.latest() ?? 'none'})`,
    );
  timer.mark('logged in (account API answered)');
}

// ---------- Lemonade ----------

const LEMONADE_LOGIN = 'https://www.lemonade.com/login#email';
const isPresign = (r: Response) => r.url().includes('www.lemonade.com/login/presign');
const isSignin = (r: Response) => r.url().includes('www.lemonade.com/login/signin');
const isPolicies = (r: Response) =>
  r.url().includes('my.lemonade.com/api/') && r.url().includes('/accounts/home/policies');

async function lemonade(page: Page, context: BrowserContext, timer: StepTimer): Promise<void> {
  await page.goto(LEMONADE_LOGIN, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_MS });
  const emailField = await firstVisible(page, 'the email field', {
    css: ['input[type="email"]', 'input[name*="email" i]', 'input[autocomplete="email"]'],
    label: /e-?mail/i,
  });
  timer.mark('login page ready');

  const email = await ask('Lemonade email:');
  timer.skip();
  await emailField.fill(email);
  const presigned = waitForResponseOrBlock(page, isPresign, 'the email check');
  await emailField.press('Enter');
  const presign = await presigned;
  if (presign.status() === 403 || presign.status() === 429) {
    await assertNotBlocked(page, 'after submitting the email');
    throw new Stop('CARRIER_BLOCKED', `email check returned HTTP ${presign.status()}`);
  }
  if (!presign.ok())
    throw new Stop('BAD_CREDENTIALS', `email check returned HTTP ${presign.status()}`);
  timer.mark('SMS sent to the account phone');

  const code = await ask('SMS code (ask the account holder):');
  timer.skip();
  const signedIn = waitForResponseOrBlock(page, isSignin, 'the code check', HUMAN_TIMEOUT_MS);
  await enterCode(page, code);
  // Many code forms submit on the last digit; press Enter if it didn't.
  await page.waitForTimeout(500);
  if (!page.url().includes('me.lemonade.com')) await page.keyboard.press('Enter').catch(() => {});
  const signin = await signedIn;
  if (!signin.ok()) throw new Stop('MFA_INVALID', `code check returned HTTP ${signin.status()}`);
  timer.mark('code accepted');

  await firstDocument(page, context, timer);
}

/** Lemonade D1: the app's own policies call carries each PDF's link; fetch the first one. */
async function firstDocument(page: Page, context: BrowserContext, timer: StepTimer): Promise<void> {
  const policies = await waitForResponseOrBlock(
    page,
    (r) => isPolicies(r) && r.ok(),
    'the policies API',
  );
  timer.mark('logged in (policies API answered)');
  const body = (await policies.json().catch(() => undefined)) as
    { data?: { items?: Record<string, { form_url?: unknown }> } } | undefined;
  const items = Object.values(body?.data?.items ?? {});
  const link = items.map((i) => i.form_url).find((u): u is string => typeof u === 'string');
  console.log(`  policies found: ${items.length}`);
  if (!link) {
    console.log('  no document link in the response (document check skipped)');
    return;
  }
  const pdf = await context.request.get(link, { timeout: STEP_TIMEOUT_MS });
  const bytes = await pdf.body();
  timer.mark('first document fetched');
  console.log(
    `  first document: HTTP ${pdf.status()}, ${Math.round(bytes.length / 1024)} KB, ` +
      `${isPdf(bytes) ? 'valid PDF' : 'NOT a PDF'} (content not saved)`,
  );
}

// ---------- repeat-run check ----------

async function repeatRun(
  carrier: 'progressive' | 'lemonade',
  context: BrowserContext,
  launch: () => Promise<BrowserContext>,
): Promise<void> {
  const state = await context.storageState(); // in memory only, never written to disk
  await context.close();
  const fresh = await launch();
  await fresh.addCookies(state.cookies);
  const page = await fresh.newPage();
  const timer = new StepTimer();
  const loggedIn =
    carrier === 'progressive'
      ? page.waitForResponse((r) => isHandshake(r) && r.ok(), { timeout: STEP_TIMEOUT_MS })
      : page.waitForResponse((r) => isPolicies(r) && r.ok(), { timeout: STEP_TIMEOUT_MS });
  await page.goto(carrier === 'progressive' ? PROGRESSIVE_LOGIN : 'https://me.lemonade.com/', {
    waitUntil: 'domcontentloaded',
    timeout: STEP_TIMEOUT_MS,
  });
  const reused = await loggedIn.then(() => true).catch(() => false);
  timer.mark(reused ? 'repeat run: logged in from saved state' : 'repeat run: login needed');
  console.log(`\nRepeat run with saved state: ${reused ? 'NO LOGIN NEEDED' : 'login required'}`);
  console.log(formatSteps(timer.steps));
  await fresh.close();
}

// ---------- main ----------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const carrier = args.find((a) => !a.startsWith('--'));
  if (carrier !== 'progressive' && carrier !== 'lemonade') {
    throw new Error('usage: live-login <progressive|lemonade> [--headed] [--no-reuse]');
  }
  const headed = args.includes('--headed');
  const executablePath = process.env.BROWSER_EXECUTABLE_PATH;

  console.log(
    `live-login: ${carrier}, patched ${headed ? 'headed' : 'headless'}, ` +
      `${process.env.RENDER ? 'Render' : 'local'}. One attempt; nothing is retried or saved.\n`,
  );
  const browser = await chromium.launch({
    headless: !headed,
    ...(executablePath ? { executablePath } : {}),
  });
  const launch = () => browser.newContext(CONTEXT_OPTIONS);
  const context = await launch();
  const page = await context.newPage();
  const timer = new StepTimer();
  let outcome: Outcome = 'OK';
  let detail = '';
  try {
    if (carrier === 'progressive') await progressive(page, timer);
    else await lemonade(page, context, timer);
  } catch (err) {
    if (err instanceof Stop) {
      outcome = err.outcome;
      detail = err.detail;
    } else {
      outcome = 'CARRIER_UNAVAILABLE';
      detail = (err as Error).message.split('\n')[0] ?? 'unknown error';
    }
  }

  console.log(`\nOutcome: ${outcome}${detail ? ` (${detail})` : ''}`);
  console.log(formatSteps(timer.steps));
  console.log('  (time spent typing credentials and codes is excluded)');

  if (outcome === 'OK' && !args.includes('--no-reuse')) {
    await repeatRun(carrier, context, launch).catch((err: Error) =>
      console.log(`repeat-run check failed: ${err.message.split('\n')[0]}`),
    );
  }
  await browser.close();
  process.exit(outcome === 'OK' ? 0 : 1);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
