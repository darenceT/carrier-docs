/**
 * The Progressive adapter in a real Chromium against a LOCAL imitation of Progressive's flow
 * (PingFederate statuses, a custom-drawn "remember this device" box, an app that keeps its Bearer
 * token in memory, and the ID card as base64 in JSON; shapes from docs/spike.md, invented data).
 * Never contacts Progressive. Skipped unless RUN_BROWSER_TESTS is set:
 *
 *   RUN_BROWSER_TESTS=1 npx vitest run apps/server/test/carriers/progressive.browser.test.ts
 *
 * BROWSER_EXECUTABLE_PATH optionally points at a specific Chromium binary.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser as TestBrowser } from '@playwright/test';
import type { BrowserContext, Page } from 'patchright';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { noPacing } from '../../src/antibot/pacing.js';
import { ProgressiveAdapter } from '../../src/carriers/progressive/adapter.js';
import { carrierContract } from './contract.js';

const USER = 'renter1';
const PASS = 'pw-123';
const CODE = '654321';
const TOKEN = 'Bearer fake-token';
const PDF_B64 = Buffer.from('%PDF-1.4\n% fake ID card\n%%EOF\n', 'latin1').toString('base64');
// A real 1x1 PNG: the app's own request returns images, which the adapter turns into a PDF.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const FLOW = '/pf-ws/authn/flows/f1';

const LOGIN_HTML = `<!doctype html><html><body>
<div id="creds"><label for="uid">User ID</label><input id="uid">
  <label for="pw">Password</label><input id="pw" type="password">
  <button id="signin">Sign In</button></div>
<div id="channel" hidden><p>How should we send your code?</p>
  <button id="sendtext">Text me a code</button></div>
<div id="otp" hidden><label for="vc">Verification code</label><input id="vc">
  <button id="verify">Verify</button><p id="err"></p></div>
<div id="remember" hidden>
  <span style="position:relative;display:inline-block">
    <input type="checkbox" id="rd" style="width:20px;height:20px;margin:0">
    <span style="position:absolute;left:0;top:0;width:20px;height:20px;background:#09f"></span>
  </span>
  <label for="rd">Remember this device</label></div>
<script>
const call = (action, body) => fetch('${FLOW}' + (action ? '?action=' + action : ''),
  { method: action ? 'POST' : 'GET', headers: { 'content-type': 'application/json' },
    body: action ? JSON.stringify(body || {}) : undefined });
call();
document.getElementById('signin').onclick = async () => {
  const r = await call('checkUsernamePassword', { username: uid.value, password: pw.value });
  if (!r.ok) return;
  const a = await (await call('authenticate')).json();
  creds.hidden = true;
  if (a.status === 'DEVICE_SELECTION_REQUIRED') { channel.hidden = false; return; }
  otp.hidden = false;
};
document.getElementById('sendtext').onclick = async () => {
  await call('selectDevice', { device: 'sms' });
  channel.hidden = true; otp.hidden = false;
};
const verifyCode = async () => {
  verify.disabled = true;
  const r = await call('checkOtp', { otp: vc.value });
  // Accepted: the button stays disabled until the page moves on (re-enabled only to retry).
  if (!r.ok) { verify.disabled = false; err.textContent = 'That code is incorrect'; vc.value = ''; return; }
  await call('continueAuthentication');
  // Like the real page, the account takes a moment to answer before the next step shows.
  await new Promise((r) => setTimeout(r, 300));
  otp.hidden = true; remember.hidden = false;
};
document.getElementById('verify').onclick = verifyCode;
// Some versions submit by themselves at six digits, leaving Verify visible but disabled.
if (__AUTO__) vc.addEventListener('input', () => { if (vc.value.length === 6) verifyCode(); });
document.getElementById('rd').onchange = async () => {
  await call('setDeviceProperties', { rememberDevice: true });
  location.href = '/app/account-home';
};
</script></body></html>`;

const APP_HOME = `<!doctype html><html><body><h1>Account</h1>
<a href="/app/id-cards">ID Cards</a>
<script>
const token = '${TOKEN}'; // in memory only, like the real app
fetch('__API__/v1/handshake', { headers: { authorization: token, 'x-prgaccountsessionid': 's1' } });
</script></body></html>`;

/** The ID cards page: the app fetches a card (as images) for each policy it shows. */
const idCardsPage = (
  policies: [string, string][],
) => `<!doctype html><html><body><h1>ID cards</h1><script>
for (const [n, key] of ${JSON.stringify(policies)}) {
  fetch('__API__/v1/policies/' + n + '/document?policyInfoKey=' + key, { method: 'POST',
    headers: { authorization: '${TOKEN}', 'x-prgaccountsessionid': 's1', 'x-prg-signature': 'sig:png', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'idCard', mimeType: 'png', format: 'electronic', dpi: 96, policyTerm: 'T1', replacementVehicles: false }) });
}
</script></body></html>`;
/** Which policies the app fetches cards for on that page. */
let appFetches: [string, string][] = [
  ['1111', 'WA-AA'],
  ['2222', 'OR-AA'],
];

const SPIKE_HANDSHAKE = {
  policySessions: [
    { policyNumber: '1111', policySessionId: 'a', policyInfoKey: 'WA-AA' },
    { policyNumber: '2222', policySessionId: 'b', policyInfoKey: 'OR-AA' },
  ],
};
/**
 * Like (we believe) the real API: each document request is signed over its body, so a copy of
 * the app's request with another mimeType is refused (401). Off: the copy is accepted.
 */
let signed = true;
/** The app sends the account home to its session-timeout page. */
let timesOut = false;
/** After the password, the flow first asks how to send the code. */
let askChannel = false;
/** The login page submits the code itself at six digits. */
let autoSubmit = false;
/** What the imitation's handshake returns; tests swap it to imitate a changed response. */
let handshakeBody: unknown = SPIKE_HANDSHAKE;

/**
 * Like the real one, the API is on another origin than the app and authenticates by Bearer
 * token, with a wildcard CORS policy: the browser refuses a request that carries cookies to it.
 */
let apiBase = '';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'authorization, content-type, x-prgaccountsessionid, x-prg-signature',
  'access-control-allow-methods': 'GET, POST',
};

function loggedIn(req: http.IncomingMessage): boolean {
  return /(^|;\s*)pf=ok/.test(req.headers.cookie ?? '');
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
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
      const api = url.pathname.startsWith('/policypro/');
      const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          ...(api ? CORS : {}),
          ...headers,
        });
        res.end(JSON.stringify(data));
      };
      const html = (page: string) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(page.replaceAll('__API__', apiBase));
      };
      if (url.pathname === '/access/login') {
        if (loggedIn(req)) {
          res.writeHead(302, { location: '/app/account-home' });
          return res.end();
        }
        return html(LOGIN_HTML.replace('__AUTO__', String(autoSubmit)));
      }
      if (url.pathname === FLOW) {
        const action = url.searchParams.get('action');
        const b = await readBody(req);
        if (!action) return json(200, { status: 'CREDENTIALS_REQUIRED' });
        if (action === 'checkUsernamePassword') {
          if (b.username !== USER || b.password !== PASS) {
            return json(400, { code: 'VALIDATION_ERROR' });
          }
          return json(200, { status: 'AUTHENTICATION_REQUIRED' });
        }
        if (action === 'authenticate') {
          return json(200, { status: askChannel ? 'DEVICE_SELECTION_REQUIRED' : 'OTP_REQUIRED' });
        }
        if (action === 'selectDevice') return json(200, { status: 'OTP_REQUIRED' });
        if (action === 'checkOtp') {
          return b.otp === CODE
            ? json(200, { status: 'MFA_COMPLETED' })
            : json(400, { code: 'INVALID_OTP' });
        }
        if (action === 'continueAuthentication') {
          return json(200, { status: 'DEVICE_PROPERTIES_REQUIRED' });
        }
        if (action === 'setDeviceProperties') {
          return json(200, { status: 'RESUME' }, { 'set-cookie': 'pf=ok; Path=/' });
        }
      }
      if (url.pathname === '/app/session-timeout') {
        return html('<!doctype html><h1>Your session has timed out</h1>');
      }
      if (url.pathname.startsWith('/app/')) {
        if (timesOut && url.pathname === '/app/account-home') {
          res.writeHead(302, { location: '/app/session-timeout' });
          return res.end();
        }
        if (!loggedIn(req)) {
          res.writeHead(302, { location: '/access/login' });
          return res.end();
        }
        return html(url.pathname === '/app/id-cards' ? idCardsPage(appFetches) : APP_HOME);
      }
      if (url.pathname.startsWith('/policypro/')) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, CORS);
          return res.end();
        }
        if (req.headers.authorization !== TOKEN) return json(401, { error: 'unauthorized' });
        if (url.pathname === '/policypro/v1/handshake') {
          return json(200, handshakeBody);
        }
        const m = /^\/policypro\/v1\/policies\/(\d+)\/document$/.exec(url.pathname);
        if (m && req.method === 'POST') {
          const b = await readBody(req);
          // The fields we don't know the meaning of must be copied from the app's request.
          if (b.type !== 'idCard' || b.policyTerm !== 'T1' || b.dpi !== 96) {
            return json(400, { error: 'bad request' });
          }
          if (!url.searchParams.get('policyInfoKey')) return json(400, { error: 'no key' });
          if (signed && req.headers['x-prg-signature'] !== `sig:${String(b.mimeType)}`) {
            return json(401, { error: 'bad signature' });
          }
          return json(200, {
            message: '',
            signature: 's',
            documents: b.mimeType === 'pdf' ? [PDF_B64] : [PNG_B64, PNG_B64],
          });
        }
      }
      res.writeHead(404);
      res.end();
    })();
  });
}

describe.skipIf(!process.env.RUN_BROWSER_TESTS)(
  'ProgressiveAdapter against a local imitation',
  () => {
    let server: http.Server;
    let browser: TestBrowser;
    let adapter: ProgressiveAdapter;
    let makeAdapter: () => ProgressiveAdapter;
    let sharedAdapter: ProgressiveAdapter;
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      server = createPortal();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;
      apiBase = `http://localhost:${port}/policypro`;
      makeAdapter = () =>
        new ProgressiveAdapter({
          pacing: noPacing,
          stepTimeoutMs: 5_000,
          urls: {
            login: `${base}/access/login`,
            appOrigin: base,
            appPathPrefix: '/app/',
            pfFlows: '/pf-ws/authn/flows',
            api: `${apiBase}/`,
          },
        });
      adapter = makeAdapter();
      sharedAdapter = adapter;
      const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
      browser = await chromium.launch(executablePath ? { executablePath } : {});
    });

    afterAll(async () => {
      await browser?.close();
      await new Promise((resolve) => server?.close(resolve));
    });

    beforeEach(async () => {
      context = (await browser.newContext()) as unknown as BrowserContext;
      context.setDefaultTimeout(30_000); // as in production (browser pool)
      page = await context.newPage();
    });

    afterEach(async () => {
      adapter = sharedAdapter;
      handshakeBody = SPIKE_HANDSHAKE;
      signed = true;
      autoSubmit = false;
      askChannel = false;
      timesOut = false;
      appFetches = [
        ['1111', 'WA-AA'],
        ['2222', 'OR-AA'],
      ];
      await context.close();
    });

    const logIn = async () => {
      await adapter.openLogin(page);
      expect(await adapter.login(page, { username: USER, password: PASS })).toMatchObject({
        kind: 'mfa_required',
      });
      expect(await adapter.submitMfa(page, CODE)).toEqual({ kind: 'ok' });
    };

    it('lists per policy the first image, then the whole card as a PDF', async () => {
      await logIn();
      const docs = await adapter.listDocuments(page);
      expect(docs.map((d) => [d.id, d.mimeType, d.policyNumberMasked])).toEqual([
        ['idcard-1', 'image/png', '••••1111'],
        ['idcard-1-pdf', 'application/pdf', '••••1111'],
        ['idcard-2', 'image/png', '••••2222'],
        ['idcard-2-pdf', 'application/pdf', '••••2222'],
      ]);
      // The headline document: the app's first image as it came, no conversion.
      const first = await adapter.fetchDocument(page, 'idcard-1');
      expect(first.mimeType).toBe('image/png');
      expect(Buffer.from(first.body as Uint8Array).toString('base64')).toBe(PNG_B64);
      // Lazily, the whole card: one page per image the app received.
      const whole = await adapter.fetchDocument(page, 'idcard-1-pdf');
      expect(whole.mimeType).toBe('application/pdf');
      expect((await PDFDocument.load(whole.body as Uint8Array)).getPageCount()).toBe(2);
    });

    it('names the refusal when a policy the app did not fetch is refused', async () => {
      appFetches = [['1111', 'WA-AA']];
      // A fresh adapter: it clicks through from the account home, which lists both policies.
      adapter = makeAdapter();
      await logIn();
      await adapter.listDocuments(page);
      await expect(adapter.fetchDocument(page, 'idcard-2')).rejects.toMatchObject({
        code: 'CARRIER_PAGE_CHANGED',
        message: "document 401; app's own none",
      });
    });

    it('fetches a policy the app did not fetch with our own request, where accepted', async () => {
      appFetches = [['1111', 'WA-AA']];
      signed = false;
      // A fresh adapter: it clicks through from the account home, which lists both policies.
      adapter = makeAdapter();
      await logIn();
      await adapter.listDocuments(page);
      const file = await adapter.fetchDocument(page, 'idcard-2');
      expect(file.mimeType).toBe('application/pdf');
      expect(
        Buffer.from(file.body as Uint8Array)
          .subarray(0, 5)
          .toString('latin1'),
      ).toBe('%PDF-');
    });

    it('reads a handshake shaped differently (nested, numeric policy numbers)', async () => {
      handshakeBody = {
        account: { policies: [{ summary: { policyNumber: 1111, policyInfoKey: 'WA-AA' } }] },
      };
      appFetches = [['1111', 'WA-AA']]; // a consistent account: one policy everywhere
      await logIn();
      const docs = await adapter.listDocuments(page);
      expect(docs.map((d) => d.id)).toEqual(['idcard-1', 'idcard-1-pdf']);
      expect(docs[0]?.policyNumberMasked).toBe('••••1111');
      const file = await adapter.fetchDocument(page, 'idcard-1-pdf');
      expect(file.mimeType).toBe('application/pdf');
    });

    it('falls back to the app’s own ID-card request when the handshake lists no policies', async () => {
      handshakeBody = { sessions: [{ id: 'a' }] };
      await logIn();
      const docs = await adapter.listDocuments(page);
      expect(docs.map((d) => [d.id, d.policyNumberMasked])).toEqual([
        ['idcard-1', '••••1111'],
        ['idcard-1-pdf', '••••1111'],
        ['idcard-2', '••••2222'],
        ['idcard-2-pdf', '••••2222'],
      ]);
      const file = await adapter.fetchDocument(page, 'idcard-1-pdf');
      expect(
        Buffer.from(file.body as Uint8Array)
          .subarray(0, 5)
          .toString('latin1'),
      ).toBe('%PDF-');
    });

    it('does not wait on a Verify button the page has disabled while it submits itself', async () => {
      autoSubmit = true;
      await adapter.openLogin(page);
      await adapter.login(page, { username: USER, password: PASS });
      const started = Date.now();
      expect(await adapter.submitMfa(page, CODE)).toEqual({ kind: 'ok' });
      expect(Date.now() - started).toBeLessThan(5_000); // was the 30 s action timeout
    });

    it('chooses "text me" as soon as the flow asks how to send the code', async () => {
      askChannel = true;
      await adapter.openLogin(page);
      const started = Date.now();
      expect(await adapter.login(page, { username: USER, password: PASS })).toMatchObject({
        kind: 'mfa_required',
      });
      expect(Date.now() - started).toBeLessThan(2_500); // was a fixed 3 s wait first
      expect(await adapter.submitMfa(page, CODE)).toEqual({ kind: 'ok' });
    });

    it('stops at once on the app’s session-timeout page instead of waiting out timeouts', async () => {
      await adapter.openLogin(page);
      await adapter.login(page, { username: USER, password: PASS });
      timesOut = true;
      await adapter.submitMfa(page, CODE).catch(() => undefined);
      const started = Date.now();
      await expect(adapter.listDocuments(page)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
      expect(Date.now() - started).toBeLessThan(3_000); // was 3 x the step timeout
    });

    it('asks again after a wrong code', async () => {
      await adapter.openLogin(page);
      await adapter.login(page, { username: USER, password: PASS });
      expect(await adapter.submitMfa(page, '000000')).toMatchObject({
        kind: 'mfa_required',
        rejected: true,
      });
      expect(await adapter.submitMfa(page, CODE)).toEqual({ kind: 'ok' });
    });

    it('reports a wrong password as BAD_CREDENTIALS', async () => {
      await adapter.openLogin(page);
      expect(await adapter.login(page, { username: USER, password: 'nope' })).toEqual({
        kind: 'failed',
        code: 'BAD_CREDENTIALS',
      });
    });

    it('recognises a valid saved session, and fetches documents from it', async () => {
      await logIn();
      const saved = await context.cookies();
      const fresh = (await browser.newContext()) as unknown as BrowserContext;
      await fresh.addCookies(saved);
      const p2 = await fresh.newPage();
      expect(await adapter.isSessionValid(p2)).toBe(true);
      expect(await adapter.listDocuments(p2)).toHaveLength(4);
      const file = await adapter.fetchDocument(p2, 'idcard-1-pdf');
      expect(
        Buffer.from(file.body as Uint8Array)
          .subarray(0, 5)
          .toString('latin1'),
      ).toBe('%PDF-');
      await fresh.close();

      const empty = (await browser.newContext()) as unknown as BrowserContext;
      expect(await adapter.isSessionValid(await empty.newPage())).toBe(false);
      await empty.close();
    });

    carrierContract(() => ({
      adapter,
      browser,
      valid: () => ({ username: USER, password: PASS }),
      mfaCode: CODE,
      wrong: { username: USER, password: 'nope' },
    }));
  },
);
