/**
 * The Demo adapter against the real mock portal in a real Chromium: the adapter contract for the
 * carrier that every end-to-end test runs on. Skipped unless RUN_BROWSER_TESTS is set; CI runs it
 * after installing the browser (see .github/workflows/ci.yml). Locally:
 *
 *   npx playwright install chromium   # once
 *   RUN_BROWSER_TESTS=1 npx vitest run apps/server/test/carriers
 *
 * Launches @playwright/test's Chromium (the adapter only needs a Page; stealth isn't under test
 * here). Only the local mock portal is contacted.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser as TestBrowser } from '@playwright/test';
import {
  MOCK_PORTAL_BASE_PATH,
  MOCK_PORTAL_MFA_CODE,
  MOCK_PORTAL_USERNAMES,
  createMockPortalApp,
} from '@carrier-docs/mock-portal';
import type { BrowserContext, Page } from 'patchright';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { noPacing } from '../../src/antibot/pacing.js';
import { DemoAdapter } from '../../src/carriers/demo/adapter.js';
import { AppError } from '../../src/core/errors.js';

const PASSWORD = 'demo-password';

describe.skipIf(!process.env.RUN_BROWSER_TESTS)('DemoAdapter against the mock portal', () => {
  let server: http.Server;
  let browser: TestBrowser;
  let adapter: DemoAdapter;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    const handle = createMockPortalApp({ slowMs: 50 }).callback();
    server = http.createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    adapter = new DemoAdapter({
      baseUrl: `http://127.0.0.1:${port}${MOCK_PORTAL_BASE_PATH}`,
      pacing: noPacing,
    });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
    });
  });

  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  beforeEach(async () => {
    // @playwright/test and patchright share the Page API; the types differ only nominally.
    context = (await browser.newContext()) as unknown as BrowserContext;
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
  });

  afterEach(async () => {
    await context.close();
  });

  const login = (username: string) => adapter.login(page, { username, password: PASSWORD });

  it('declares its login fields', () => {
    expect(adapter.info).toMatchObject({
      id: 'demo',
      isDemo: true,
      loginFields: ['username', 'password'],
    });
  });

  it('MFA path: login asks for a code with the hint, the right code logs in', async () => {
    await adapter.openLogin(page);
    expect(await login('alice')).toEqual({
      kind: 'mfa_required',
      rejected: false,
      hint: 'We sent a code to •••-•••-1234',
    });
    expect(await adapter.submitMfa(page, MOCK_PORTAL_MFA_CODE)).toEqual({ kind: 'ok' });
    expect(await adapter.isSessionValid(page)).toBe(true);
  });

  it('logs in from a fresh page too (no pre-warm)', async () => {
    expect((await login('alice')).kind).toBe('mfa_required');
  });

  it('a wrong code is rejected, then three wrong codes lock out with MFA_INVALID', async () => {
    await login('bob');
    expect(await adapter.submitMfa(page, '000000')).toMatchObject({
      kind: 'mfa_required',
      rejected: true,
    });
    await adapter.submitMfa(page, '000000');
    expect(await adapter.submitMfa(page, '000000')).toEqual({
      kind: 'failed',
      code: 'MFA_INVALID',
    });
  });

  it('no-MFA user goes straight in', async () => {
    expect(await login(MOCK_PORTAL_USERNAMES.noMfa)).toEqual({ kind: 'ok' });
  });

  it('wrong password -> BAD_CREDENTIALS', async () => {
    expect(await login(MOCK_PORTAL_USERNAMES.wrongPassword)).toEqual({
      kind: 'failed',
      code: 'BAD_CREDENTIALS',
    });
  });

  it('blocked -> CARRIER_BLOCKED', async () => {
    expect(await login(MOCK_PORTAL_USERNAMES.blocked)).toEqual({
      kind: 'failed',
      code: 'CARRIER_BLOCKED',
    });
  });

  it('slow login still completes', async () => {
    expect((await login(MOCK_PORTAL_USERNAMES.slow)).kind).toBe('mfa_required');
  });

  it('trusted device: "remember this device" skips MFA on the next login', async () => {
    await login('carol');
    await adapter.submitMfa(page, MOCK_PORTAL_MFA_CODE);
    await context.clearCookies({ name: 'demo_session' });
    expect(await adapter.isSessionValid(page)).toBe(false);
    expect(await login('carol')).toEqual({ kind: 'ok' });
  });

  it('lists documents ID card first, masked, and downloads the PDF in-page', async () => {
    await login(MOCK_PORTAL_USERNAMES.noMfa);
    const docs = await adapter.listDocuments(page);
    expect(docs[0]).toEqual({
      id: 'auto-id-card',
      title: 'Auto ID Card',
      kind: 'id_card',
      policyNumberMasked: '••••1234',
      mimeType: 'application/pdf',
    });
    expect(docs.map((d) => d.kind)).toEqual(['id_card', 'declarations', 'declarations', 'policy']);

    const file = await adapter.fetchDocument(page, 'auto-id-card');
    expect(file.mimeType).toBe('application/pdf');
    expect(file.filename).toMatch(/\.pdf$/);
    const bytes = file.body as Uint8Array;
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
  });

  it('fetches a document on a reopened page without listing first', async () => {
    await login(MOCK_PORTAL_USERNAMES.noMfa);
    const reopened = await context.newPage();
    await adapter.isSessionValid(reopened);
    const file = await adapter.fetchDocument(reopened, 'renters-declarations');
    expect((file.body as Uint8Array).length).toBeGreaterThan(100);
  });

  it('an unknown document is NOT_FOUND; a logged-out page is SESSION_EXPIRED', async () => {
    await login(MOCK_PORTAL_USERNAMES.noMfa);
    await expect(adapter.fetchDocument(page, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await context.clearCookies();
    const err = await adapter.listDocuments(page).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it('an unreachable portal is CARRIER_UNAVAILABLE', async () => {
    const dead = new DemoAdapter({ baseUrl: 'http://127.0.0.1:9/demo-portal', pacing: noPacing });
    await expect(dead.openLogin(page)).rejects.toMatchObject({ code: 'CARRIER_UNAVAILABLE' });
  });
});
