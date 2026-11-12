/**
 * The Lemonade adapter in a real Chromium against a LOCAL imitation of Lemonade's flow (shapes
 * from docs/spike.md, invented data). Never contacts Lemonade. Skipped unless RUN_BROWSER_TESTS is
 * set, like the Demo adapter's browser test:
 *
 *   RUN_BROWSER_TESTS=1 npx vitest run apps/server/test/carriers/lemonade.browser.test.ts
 *
 * BROWSER_EXECUTABLE_PATH optionally points at a specific Chromium binary.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser as TestBrowser } from '@playwright/test';
import type { BrowserContext, Page } from 'patchright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { noPacing } from '../../src/antibot/pacing.js';
import { LemonadeAdapter } from '../../src/carriers/lemonade/adapter.js';
import { carrierContract } from './contract.js';

const CODE = '123456';
const POLICIES_PATH = '/api/v1/web_dashboard/accounts/home/policies';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

/** Knobs the tests flip. */
const portal = {
  requireCsrf: false,
  tokens: new Set<string>(),
};

const LOGIN_HTML = `<!doctype html><html><body>
<h1>Log in</h1>
<form id="f"><input type="email" name="email"><button>Continue</button></form>
<div id="code-step" hidden><p>Enter the code we texted you</p>
  <input id="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6"></div>
<script>
const f = document.getElementById('f'), code = document.getElementById('code');
f.onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch('/login/presign', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: f.email.value, preferred_channel: 'sms' }) });
  if (r.ok) { f.hidden = true; document.getElementById('code-step').hidden = false; }
};
code.oninput = async () => {
  if (code.value.length !== 6) return;
  const r = await fetch('/login/signin', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.value, consentReceived: true }) });
  if (r.status === 201) { const to = (await r.json()).redirectTo; setTimeout(() => { location.href = to; }, 400); } else code.value = '';
};
</script></body></html>`;

const APP_HTML = `<!doctype html><html><body><h1>Home</h1><script>
setTimeout(() => fetch('${POLICIES_PATH}', { credentials: 'include', headers: { 'x-csrf-token': 't' } }), 200);
</script></body></html>`;

function loggedIn(req: http.IncomingMessage): boolean {
  return /(^|;\s*)customer_session=ok/.test(req.headers.cookie ?? '');
}

function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => resolve(JSON.parse(raw || '{}') as Record<string, unknown>));
  });
}

function createPortal(): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const base = `http://${req.headers.host}`;
      const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === '/login') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(LOGIN_HTML);
      }
      if (url.pathname === '/login/presign' && req.method === 'POST') {
        const { email } = await body(req);
        if (email === 'blocked@example.com') {
          res.writeHead(403, { 'content-type': 'text/html' });
          return res.end('<h1>Sorry, you have been blocked</h1>');
        }
        if (email === 'unknown@example.com') return json(404, { error: 'not_found' });
        return json(200, { publicId: 'p', channel: 'sms', digits: 6 });
      }
      if (url.pathname === '/login/signin' && req.method === 'POST') {
        const { code } = await body(req);
        if (code !== CODE) return json(401, { error: 'bad_code' });
        // Like the real site: sign-in answers with a redirect target, and only following THAT
        // establishes the login on the app (a one-time handoff). No cookie is set here.
        return json(201, { redirectTo: `${base}/handoff?t=one-time` });
      }
      if (url.pathname === '/handoff') {
        if (url.searchParams.get('t') !== 'one-time') {
          res.writeHead(302, { location: '/login' });
          return res.end();
        }
        res.writeHead(302, { location: '/home', 'set-cookie': 'customer_session=ok; Path=/' });
        return res.end();
      }
      if (url.pathname === '/home') {
        if (!loggedIn(req)) {
          res.writeHead(302, { location: '/login' });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(APP_HTML);
      }
      if (url.pathname === POLICIES_PATH) {
        if (!loggedIn(req)) return json(401, { error: 'unauthorized' });
        if (portal.requireCsrf && !req.headers['x-csrf-token']) return json(403, { error: 'csrf' });
        // New tokens on every call, like the real links.
        const one = randomUUID();
        const two = randomUUID();
        portal.tokens.add(one).add(two);
        return json(200, {
          data: {
            items: {
              LP0000FAKE01: {
                id: 'LP0000FAKE01',
                humanized_type: 'Renters Policy',
                address: '1 Example St',
                form_url: `${base}/tokens/${one}`,
              },
              LP0000FAKE02: {
                id: 'LP0000FAKE02',
                humanized_type: 'Renters Policy',
                address: '2 Sample Ave',
                form_url: `${base}/tokens/${two}`,
              },
            },
          },
        });
      }
      if (url.pathname.startsWith('/tokens/')) {
        // Cookie-free, like icebox.lemonade.com: the token is the permission.
        if (!portal.tokens.has(url.pathname.slice('/tokens/'.length))) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="policy.pdf"',
        });
        return res.end(PDF);
      }
      res.writeHead(404);
      res.end();
    })();
  });
}

describe.skipIf(!process.env.RUN_BROWSER_TESTS)('LemonadeAdapter against a local imitation', () => {
  let server: http.Server;
  let browser: TestBrowser;
  let adapter: LemonadeAdapter;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    server = createPortal();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    adapter = new LemonadeAdapter({
      pacing: noPacing,
      stepTimeoutMs: 5_000,
      urls: {
        login: `${base}/login#email`,
        presign: `${base}/login/presign`,
        signin: `${base}/login/signin`,
        appHome: `${base}/home`,
        policiesApi: `${base}${POLICIES_PATH}`,
      },
    });
    const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
    browser = await chromium.launch(executablePath ? { executablePath } : {});
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  beforeEach(async () => {
    portal.requireCsrf = false;
    portal.tokens.clear();
    context = (await browser.newContext()) as unknown as BrowserContext;
    page = await context.newPage();
  });

  afterEach(async () => {
    await context.close();
  });

  const logIn = async () => {
    await adapter.openLogin(page);
    expect(await adapter.login(page, { email: 'renter@example.com' })).toMatchObject({
      kind: 'mfa_required',
    });
    expect(await adapter.submitMfa(page, CODE)).toEqual({ kind: 'ok' });
  };

  it('logs in with email and SMS code, lists the policies and fetches a PDF', async () => {
    await logIn();
    const docs = await adapter.listDocuments(page);
    expect(docs.map((d) => d.id)).toEqual(['policy-1', 'policy-2']);
    expect(JSON.stringify(docs)).not.toContain('/tokens/');
    const file = await adapter.fetchDocument(page, 'policy-1');
    expect(file.mimeType).toBe('application/pdf');
    expect(file.filename).toBe('policy.pdf');
    expect(
      Buffer.from(file.body as Uint8Array)
        .subarray(0, 5)
        .toString('latin1'),
    ).toBe('%PDF-');
  });

  it('asks again after a wrong code, then accepts the right one', async () => {
    await adapter.openLogin(page);
    await adapter.login(page, { email: 'renter@example.com' });
    expect(await adapter.submitMfa(page, '000000')).toMatchObject({
      kind: 'mfa_required',
      rejected: true,
    });
    expect(await adapter.submitMfa(page, CODE)).toEqual({ kind: 'ok' });
  });

  it('reports an unknown email as BAD_CREDENTIALS and a 403 as CARRIER_BLOCKED', async () => {
    await adapter.openLogin(page);
    expect(await adapter.login(page, { email: 'unknown@example.com' })).toEqual({
      kind: 'failed',
      code: 'BAD_CREDENTIALS',
    });
    await adapter.openLogin(page);
    expect(await adapter.login(page, { email: 'blocked@example.com' })).toEqual({
      kind: 'failed',
      code: 'CARRIER_BLOCKED',
    });
  });

  it("falls back to the web app's own policies call when ours is refused", async () => {
    await logIn();
    portal.requireCsrf = true; // our call has no CSRF header; the app's has one
    const docs = await adapter.listDocuments(page);
    expect(docs).toHaveLength(2);
  });

  it('re-lists once when a PDF link has expired', async () => {
    await logIn();
    await adapter.listDocuments(page);
    portal.tokens.clear(); // every link handed out so far is now dead
    const file = await adapter.fetchDocument(page, 'policy-2');
    expect(
      Buffer.from(file.body as Uint8Array)
        .subarray(0, 5)
        .toString('latin1'),
    ).toBe('%PDF-');
  });

  it('recognises a valid saved session, and an expired one', async () => {
    await logIn();
    const saved = await context.cookies();
    const fresh = (await browser.newContext()) as unknown as BrowserContext;
    await fresh.addCookies(saved);
    expect(await adapter.isSessionValid(await fresh.newPage())).toBe(true);
    await fresh.close();

    const empty = (await browser.newContext()) as unknown as BrowserContext;
    expect(await adapter.isSessionValid(await empty.newPage())).toBe(false);
    await empty.close();
  });

  it('on a repeat run, lists from the policies the session check loaded: one call, not two', async () => {
    await logIn();
    const saved = await context.cookies();
    const fresh = (await browser.newContext()) as unknown as BrowserContext;
    await fresh.addCookies(saved);
    const restored = await fresh.newPage();

    expect(await adapter.isSessionValid(restored)).toBe(true);
    const afterCheck = portal.tokens.size; // two new links per policies call
    const docs = await adapter.listDocuments(restored);
    expect(docs).toHaveLength(2);
    expect(portal.tokens.size).toBe(afterCheck);
    const file = await adapter.fetchDocument(restored, docs[0]!.id);
    expect(
      Buffer.from(file.body as Uint8Array)
        .subarray(0, 5)
        .toString('latin1'),
    ).toBe('%PDF-');

    // Used once: a later listing asks again, for fresh links.
    await adapter.listDocuments(restored);
    expect(portal.tokens.size).toBe(afterCheck + 2);
    await fresh.close();
  });

  carrierContract(() => ({
    adapter,
    browser,
    valid: () => ({ email: 'renter@example.com' }),
    mfaCode: CODE,
    wrong: { email: 'unknown@example.com' },
  }));
});
