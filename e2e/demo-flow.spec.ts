import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * The whole Demo-carrier flow through the real app: UI -> API -> SessionManager -> anti-bot
 * layer (patched headless Chromium) -> DemoAdapter -> the mock portal at /demo-portal, which
 * this same server serves. Only that local portal is contacted; no real carrier.
 *
 * Each test gets a fresh browser context, so a fresh access cookie and owner: nothing is shared
 * between tests except the one browser slot (MAX_SESSIONS=1), which is why they run serially.
 */

const ACCESS_CODE = 'e2e-access-code'; // set in playwright.config.ts
const MFA_CODE = '123456'; // the mock portal's code; only unlocks fixture data
const PASSWORD = 'demo-password';

async function enter(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await page.getByLabel('Access code').fill(ACCESS_CODE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Log in to your carrier' })).toBeVisible();
}

async function startLogin(page: Page, username: string): Promise<void> {
  await page.getByLabel('Carrier').selectOption('demo');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Get my documents' }).click();
}

async function submitCode(page: Page, code: string): Promise<void> {
  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
}

async function expectDocuments(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible();
  await expect(page.getByTestId('headline')).toContainText('First document in');
  // ID card first, shown inline.
  await expect(page.locator('ul.docs button').first()).toHaveText('Auto ID Card');
  await expect(page.locator('iframe[title="Auto ID Card"]')).toBeVisible();
  await expect(page.getByTestId('status')).toHaveText('Done');
}

async function newUser(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await enter(page);
  return page;
}

test.describe('Demo carrier, end to end', () => {
  test.setTimeout(60_000);

  test('MFA path: code, then the ID card inline, served as a real PDF', async ({ page }) => {
    await enter(page);
    await startLogin(page, 'alice');
    await expect(page.getByRole('heading', { name: 'Verification code' })).toBeVisible();
    await expect(page.getByText('We sent a code to •••-•••-1234')).toBeVisible();
    await submitCode(page, MFA_CODE);
    await expectDocuments(page);
    // Counted from the code's submission; the total from the start is shown under it.
    await expect(page.getByTestId('headline')).toContainText('after your code');
    await expect(page.getByTestId('total')).toContainText('Total from start');

    const src = await page.locator('iframe[title="Auto ID Card"]').getAttribute('src');
    const pdf = await page.request.get(src!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // Another document comes from the server's memory, not a new carrier login.
    await page.getByRole('button', { name: 'Auto Declarations Page' }).click();
    await expect(page.locator('iframe[title="Auto Declarations Page"]')).toBeVisible();
  });

  test('no-MFA path goes straight to documents', async ({ page }) => {
    await enter(page);
    await startLogin(page, 'demo-nomfa');
    await expectDocuments(page);
    await expect(page.getByTestId('headline')).not.toContainText('after your code');
    await expect(page.getByRole('heading', { name: 'Verification code' })).toHaveCount(0);
  });

  // Over the polling fallback (?transport=poll), which the server can also choose with
  // EVENTS_TRANSPORT=poll. One test, as the access-code limit (10 per IP) caps the suite.
  test('a wrong code is rejected and can be retried (polling transport, no event stream)', async ({
    page,
  }) => {
    const streams: string[] = [];
    const polls: string[] = [];
    page.on('request', (req) => {
      const path = new URL(req.url()).pathname;
      if (path.endsWith('/events')) streams.push(path);
      if (path.endsWith('/snapshot')) polls.push(path);
    });
    await enter(page, '/?transport=poll');
    await startLogin(page, 'bob');
    await submitCode(page, '000000');
    await expect(page.getByText('Code rejected. Check it and try again.')).toBeVisible();
    await expect(page.getByText('Attempts left: 2')).toBeVisible();
    await submitCode(page, MFA_CODE);
    await expectDocuments(page);
    expect(streams).toEqual([]);
    expect(polls.length).toBeGreaterThan(1);
  });

  test('wrong password shows BAD_CREDENTIALS', async ({ page }) => {
    await enter(page);
    await startLogin(page, 'demo-wrongpass');
    await expect(page.getByRole('heading', { name: 'That did not work' })).toBeVisible();
    await expect(page.locator('code', { hasText: 'BAD_CREDENTIALS' })).toBeVisible();
  });

  test('a blocked login shows CARRIER_BLOCKED', async ({ page }) => {
    await enter(page);
    await startLogin(page, 'demo-blocked');
    await expect(page.getByRole('heading', { name: 'That did not work' })).toBeVisible();
    await expect(page.locator('code', { hasText: 'CARRIER_BLOCKED' })).toBeVisible();
  });

  test('a repeat run takes the fast path: no MFA, saved session checked', async ({ page }) => {
    await enter(page);
    await startLogin(page, 'carol');
    await submitCode(page, MFA_CODE);
    await expectDocuments(page);

    await page.getByRole('button', { name: 'Start over' }).click();
    await startLogin(page, 'carol');
    await expectDocuments(page);
    await expect(page.getByRole('heading', { name: 'Verification code' })).toHaveCount(0);
    await expect(page.locator('.status td', { hasText: 'checking_session' })).toBeVisible();
    await expect(page.locator('.status td', { hasText: 'logging_in' })).toHaveCount(0);
  });

  test('"Forget me" deletes the saved session, so the next run needs MFA again', async ({
    page,
  }) => {
    await enter(page);
    await startLogin(page, 'dave');
    await submitCode(page, MFA_CODE);
    await expectDocuments(page);

    await page.getByRole('button', { name: 'Forget me' }).click();
    await expect(page.getByText('Forgotten: deleted 1 saved session.')).toBeVisible();

    await page.getByRole('button', { name: 'Start over' }).click();
    await startLogin(page, 'dave');
    // The device-trust cookie went with the saved session: the carrier asks for a code again.
    await expect(page.getByRole('heading', { name: 'Verification code' })).toBeVisible();
    // Finish, so this session doesn't keep the only slot for the next test.
    await submitCode(page, MFA_CODE);
    await expectDocuments(page);
  });

  test('at the cap a second user waits in line, then gets their documents', async ({ browser }) => {
    const first = await newUser(browser);
    await startLogin(first, 'erin'); // holds the only slot while waiting for MFA
    await expect(first.getByRole('heading', { name: 'Verification code' })).toBeVisible();

    const second = await newUser(browser);
    await startLogin(second, 'demo-nomfa');
    await expect(second.getByTestId('status')).toHaveText('Waiting for a free login slot');

    await submitCode(first, MFA_CODE);
    await expectDocuments(first);
    await expectDocuments(second);
  });

  test('/api/status counts the runs above per carrier, with latency percentiles', async ({
    page,
  }) => {
    await enter(page);
    const res = await page.request.get('/api/status');
    expect(res.status()).toBe(200);
    const demo = (await res.json()).carriers.demo;
    expect(demo.attempts).toBeGreaterThanOrEqual(9);
    expect(demo.outcomes.done).toBeGreaterThanOrEqual(7);
    expect(demo.outcomes.BAD_CREDENTIALS).toBeGreaterThanOrEqual(1);
    expect(demo.outcomes.CARRIER_BLOCKED).toBeGreaterThanOrEqual(1);
    expect(demo.blockRate).toBeGreaterThan(0);
    expect(demo.timeToFirstDocument.fastPath.count).toBeGreaterThanOrEqual(1);
    expect(demo.timeToFirstDocument.all.p95).toBeGreaterThan(0);
  });
});
