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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { noPacing } from '../../src/antibot/pacing.js';
import { ProgressiveAdapter } from '../../src/carriers/progressive/adapter.js';
import { carrierContract } from './contract.js';

const USER = 'renter1';
const PASS = 'pw-123';
const CODE = '654321';
const TOKEN = 'Bearer fake-token';
const PDF_B64 = Buffer.from('%PDF-1.4\n% fake ID card\n%%EOF\n', 'latin1').toString('base64');
const PNG_B64 = Buffer.from('\x89PNG fake', 'latin1').toString('base64');

const FLOW = '/pf-ws/authn/flows/f1';

const LOGIN_HTML = `<!doctype html><html><body>
<div id="creds"><label for="uid">User ID</label><input id="uid">
  <label for="pw">Password</label><input id="pw" type="password">
  <button id="signin">Sign In</button></div>
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
  await call('authenticate');
  creds.hidden = true; otp.hidden = false;
};
document.getElementById('verify').onclick = async () => {
  const r = await call('checkOtp', { otp: vc.value });
  if (!r.ok) { err.textContent = 'That code is incorrect'; vc.value = ''; return; }
  await call('continueAuthentication');
  otp.hidden = true; remember.hidden = false;
};
document.getElementById('rd').onchange = async () => {
  await call('setDeviceProperties', { rememberDevice: true });
  location.href = '/app/account-home';
};
</script></body></html>`;

const APP_HOME = `<!doctype html><html><body><h1>Account</h1>
<a href="/app/id-cards">ID Cards</a>
<script>
const token = '${TOKEN}'; // in memory only, like the real app
fetch('/policypro/v1/handshake', { headers: { authorization: token, 'x-prgaccountsessionid': 's1' } });
</script></body></html>`;

const ID_CARDS = `<!doctype html><html><body><h1>ID cards</h1><script>
fetch('/policypro/v1/policies/1111/document?policyInfoKey=WA-AA', { method: 'POST',
  headers: { authorization: '${TOKEN}', 'x-prgaccountsessionid': 's1', 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'idCard', mimeType: 'png', format: 'electronic', dpi: 96, policyTerm: 'T1', replacementVehicles: false }) });
</script></body></html>`;

const SPIKE_HANDSHAKE = {
  policySessions: [
    { policyNumber: '1111', policySessionId: 'a', policyInfoKey: 'WA-AA' },
    { policyNumber: '2222', policySessionId: 'b', policyInfoKey: 'OR-AA' },
  ],
};
/** What the imitation's handshake returns; tests swap it to imitate a changed response. */
let handshakeBody: unknown = SPIKE_HANDSHAKE;

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
      const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      const html = (page: string) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(page);
      };
      if (url.pathname === '/access/login') {
        if (loggedIn(req)) {
          res.writeHead(302, { location: '/app/account-home' });
          return res.end();
        }
        return html(LOGIN_HTML);
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
        if (action === 'authenticate') return json(200, { status: 'OTP_REQUIRED' });
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
      if (url.pathname.startsWith('/app/')) {
        if (!loggedIn(req)) {
          res.writeHead(302, { location: '/access/login' });
          return res.end();
        }
        return html(url.pathname === '/app/id-cards' ? ID_CARDS : APP_HOME);
      }
      if (url.pathname.startsWith('/policypro/')) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
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
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      server = createPortal();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      adapter = new ProgressiveAdapter({
        pacing: noPacing,
        stepTimeoutMs: 5_000,
        urls: {
          login: `${base}/access/login`,
          appOrigin: base,
          appPathPrefix: '/app/',
          pfFlows: '/pf-ws/authn/flows',
          api: `${base}/policypro/`,
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
      context = (await browser.newContext()) as unknown as BrowserContext;
      page = await context.newPage();
    });

    afterEach(async () => {
      handshakeBody = SPIKE_HANDSHAKE;
      await context.close();
    });

    const logIn = async () => {
      await adapter.openLogin(page);
      expect(await adapter.login(page, { username: USER, password: PASS })).toMatchObject({
        kind: 'mfa_required',
      });
      expect(await adapter.submitMfa(page, CODE)).toEqual({ kind: 'ok' });
    };

    it('logs in, ticks remember-device via its label, lists ID cards and fetches a PDF', async () => {
      await logIn();
      const docs = await adapter.listDocuments(page);
      expect(docs.map((d) => [d.id, d.kind, d.policyNumberMasked])).toEqual([
        ['idcard-1', 'id_card', '••••1111'],
        ['idcard-2', 'id_card', '••••2222'],
      ]);
      // The second policy too: the template from the app's request is reused with its key.
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
      await logIn();
      const docs = await adapter.listDocuments(page);
      expect(docs.map((d) => d.policyNumberMasked)).toEqual(['••••1111']);
      const file = await adapter.fetchDocument(page, 'idcard-1');
      expect(file.mimeType).toBe('application/pdf');
    });

    it('falls back to the app’s own ID-card request when the handshake lists no policies', async () => {
      handshakeBody = { sessions: [{ id: 'a' }] };
      await logIn();
      const docs = await adapter.listDocuments(page);
      expect(docs.map((d) => [d.id, d.policyNumberMasked])).toEqual([['idcard-1', '••••1111']]);
      const file = await adapter.fetchDocument(page, 'idcard-1');
      expect(
        Buffer.from(file.body as Uint8Array)
          .subarray(0, 5)
          .toString('latin1'),
      ).toBe('%PDF-');
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
      expect(await adapter.listDocuments(p2)).toHaveLength(2);
      const file = await adapter.fetchDocument(p2, 'idcard-1');
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
