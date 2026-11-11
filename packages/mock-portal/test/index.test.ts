import type { Server } from 'node:http';
import Koa from 'koa';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  MOCK_DOCUMENTS,
  MOCK_PORTAL_BASE_PATH,
  MOCK_PORTAL_MFA_CODE,
  buildPdf,
  createMockPortalApp,
  createMockPortalRouter,
  type MockPortalOptions,
} from '../src/index.js';

const BASE = MOCK_PORTAL_BASE_PATH;

function portal(options: MockPortalOptions = {}) {
  const app = createMockPortalApp({ slowMs: 50, ...options });
  return request.agent(app.callback() as unknown as Server);
}

type Agent = ReturnType<typeof portal>;

async function formToken(agent: Agent, base = BASE): Promise<string> {
  const res = await agent.get(`${base}/login`).expect(200);
  const match = /name="formToken" value="([^"]+)"/.exec(res.text);
  if (!match?.[1]) throw new Error('no form token on login page');
  return match[1];
}

async function login(agent: Agent, username: string, password = 'pw', base = BASE) {
  const token = await formToken(agent, base);
  return agent.post(`${base}/login`).type('form').send({ formToken: token, username, password });
}

async function signedIn(agent: Agent, username = 'alex', remember = false) {
  expect((await login(agent, username)).status).toBe(302);
  const res = await agent
    .post(`${BASE}/mfa`)
    .type('form')
    .send(
      remember ? { code: MOCK_PORTAL_MFA_CODE, remember: 'on' } : { code: MOCK_PORTAL_MFA_CODE },
    );
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe(`${BASE}/dashboard`);
  return res;
}

function cookieHeader(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? (raw as string[]) : [];
}

describe('constants', () => {
  it('mounts under /demo-portal with the documented MFA code', () => {
    expect(MOCK_PORTAL_BASE_PATH).toBe('/demo-portal');
    expect(MOCK_PORTAL_MFA_CODE).toBe('123456');
  });
});

describe('GET /login', () => {
  it('renders a sign-in form with stable ids, names and a form token', async () => {
    const res = await portal().get(`${BASE}/login`).expect(200);
    expect(res.type).toBe('text/html');
    expect(res.text).toContain('<h1>Sign in</h1>');
    expect(res.text).toContain('id="username" name="username"');
    expect(res.text).toContain('id="password" name="password"');
    expect(res.text).toContain('id="login-submit"');
    expect(res.text).toMatch(/type="hidden" id="form-token" name="formToken" value="[\w-]{10,}"/);
    expect(res.text).toContain(`action="${BASE}/login"`);
  });

  it('redirects the base path to login, or to the dashboard when signed in', async () => {
    const agent = portal();
    expect((await agent.get(`${BASE}/`)).headers.location).toBe(`${BASE}/login`);
    await signedIn(agent);
    expect((await agent.get(`${BASE}/`)).headers.location).toBe(`${BASE}/dashboard`);
  });
});

describe('POST /login', () => {
  it('rejects a missing or reused form token', async () => {
    const agent = portal();
    const missing = await agent
      .post(`${BASE}/login`)
      .type('form')
      .send({ username: 'alex', password: 'pw' });
    expect(missing.status).toBe(400);
    expect(missing.text).toContain('form expired');

    const token = await formToken(agent);
    await agent
      .post(`${BASE}/login`)
      .type('form')
      .send({ formToken: token, username: 'alex', password: 'pw' })
      .expect(302);
    const reused = await agent
      .post(`${BASE}/login`)
      .type('form')
      .send({ formToken: token, username: 'alex', password: 'pw' });
    expect(reused.status).toBe(400);
  });

  it('re-renders with an error for an empty password', async () => {
    const res = await login(portal(), 'alex', '');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Enter your username and password');
  });

  it('demo-wrongpass re-renders the form with an error (HTTP 200)', async () => {
    const res = await login(portal(), 'demo-wrongpass');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Invalid username or password');
    expect(res.text).toContain('<h1>Sign in</h1>');
    expect(res.text).toContain('value="demo-wrongpass"');
  });

  it('escapes the echoed username', async () => {
    const res = await login(portal(), '<b>x</b>', '');
    expect(res.text).toContain('value="&lt;b&gt;x&lt;/b&gt;"');
  });

  it('demo-blocked gets a 403 Access Denied page', async () => {
    const res = await login(portal(), 'demo-blocked');
    expect(res.status).toBe(403);
    expect(res.text).toContain('Access Denied');
    expect(res.text).toContain('Reference #18.demo');
  });

  it('demo-slow waits slowMs and then continues to MFA', async () => {
    const agent = portal({ slowMs: 200 });
    const started = Date.now();
    const res = await login(agent, 'demo-slow');
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${BASE}/mfa`);
  });

  it('demo-nomfa skips MFA and lands on the dashboard', async () => {
    const agent = portal();
    const res = await login(agent, 'demo-nomfa');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${BASE}/dashboard`);
    expect(cookieHeader(res).some((c) => /^demo_session=[^;]+;.*httponly/i.test(c))).toBe(true);
    await agent.get(`${BASE}/dashboard`).expect(200);
  });

  it('any other user is sent to MFA', async () => {
    const res = await login(portal(), 'alex');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${BASE}/mfa`);
  });
});

describe('MFA', () => {
  it('GET /mfa without a pending login redirects to /login', async () => {
    const res = await portal().get(`${BASE}/mfa`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${BASE}/login`);
  });

  it('GET /mfa shows the code form, remember checkbox and hint', async () => {
    const agent = portal();
    expect((await login(agent, 'alex')).status).toBe(302);
    const res = await agent.get(`${BASE}/mfa`).expect(200);
    expect(res.text).toContain('id="code" name="code"');
    expect(res.text).toContain('id="remember" name="remember"');
    expect(res.text).toContain('Remember this device');
    expect(res.text).toContain('We sent a code to •••-•••-1234');
  });

  it('the correct code sets an httpOnly session cookie and redirects to the dashboard', async () => {
    const agent = portal();
    const res = await signedIn(agent);
    const cookies = cookieHeader(res);
    expect(cookies.some((c) => /^demo_session=[^;]+;.*httponly/i.test(c))).toBe(true);
    expect(cookies.some((c) => c.startsWith('device_trust='))).toBe(false);
    await agent.get(`${BASE}/dashboard`).expect(200);
  });

  it('honours a custom mfaCode', async () => {
    const agent = portal({ mfaCode: '654321' });
    expect((await login(agent, 'alex')).status).toBe(302);
    const wrong = await agent.post(`${BASE}/mfa`).type('form').send({ code: '123456' });
    expect(wrong.text).toContain("That code didn't work");
    const ok = await agent.post(`${BASE}/mfa`).type('form').send({ code: '654321' });
    expect(ok.headers.location).toBe(`${BASE}/dashboard`);
  });

  it('a wrong code re-renders with attempts left', async () => {
    const agent = portal();
    expect((await login(agent, 'alex')).status).toBe(302);
    const first = await agent.post(`${BASE}/mfa`).type('form').send({ code: '000000' });
    expect(first.status).toBe(200);
    expect(first.text).toContain("That code didn't work. 2 attempts left.");
    const second = await agent.post(`${BASE}/mfa`).type('form').send({ code: '000000' });
    expect(second.text).toContain("That code didn't work. 1 attempt left.");
  });

  it('three wrong codes lock out and end the pending login', async () => {
    const agent = portal();
    expect((await login(agent, 'alex')).status).toBe(302);
    for (let i = 0; i < 2; i++) {
      await agent.post(`${BASE}/mfa`).type('form').send({ code: '000000' }).expect(200);
    }
    const third = await agent.post(`${BASE}/mfa`).type('form').send({ code: '000000' });
    expect(third.text).toContain('Too many attempts');
    // Even the right code no longer works: the pending login is gone.
    const after = await agent.post(`${BASE}/mfa`).type('form').send({ code: MOCK_PORTAL_MFA_CODE });
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe(`${BASE}/login`);
    await agent.get(`${BASE}/dashboard`).expect(302);
  });

  it('"remember this device" sets a device_trust cookie that skips MFA next time', async () => {
    const agent = portal();
    const res = await signedIn(agent, 'alex', true);
    const trust = cookieHeader(res).find((c) => c.startsWith('device_trust='));
    expect(trust).toBeDefined();
    expect(trust).toMatch(/httponly/i);
    expect(trust).toMatch(/expires=/i);

    await agent.post(`${BASE}/logout`).expect(302);
    await agent.get(`${BASE}/dashboard`).expect(302);

    const again = await login(agent, 'alex');
    expect(again.status).toBe(302);
    expect(again.headers.location).toBe(`${BASE}/dashboard`);
    await agent.get(`${BASE}/dashboard`).expect(200);
  });

  it('device_trust is bound to the username that set it', async () => {
    const agent = portal();
    await signedIn(agent, 'alex', true);
    const other = await login(agent, 'sam');
    expect(other.headers.location).toBe(`${BASE}/mfa`);
  });

  it('a forged device_trust cookie does not skip MFA', async () => {
    const agent = portal();
    const token = await formToken(agent);
    const res = await agent
      .post(`${BASE}/login`)
      .set('Cookie', 'device_trust=forged')
      .type('form')
      .send({ formToken: token, username: 'alex', password: 'pw' });
    expect(res.headers.location).toBe(`${BASE}/mfa`);
  });
});

describe('dashboard and documents API', () => {
  it('GET /dashboard without a session redirects to /login', async () => {
    const res = await portal().get(`${BASE}/dashboard`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${BASE}/login`);
  });

  it('GET /dashboard lists the Auto and Renters policies with document links', async () => {
    const agent = portal();
    await signedIn(agent);
    const res = await agent.get(`${BASE}/dashboard`).expect(200);
    expect(res.text).toContain('Auto policy DEMO-0000-1234');
    expect(res.text).toContain('Renters policy DEMO-0000-5678');
    expect(res.text).toContain(`href="${BASE}/api/documents/auto-id-card/download"`);
  });

  it('GET /api/documents without a session is a 401 JSON error', async () => {
    const res = await portal().get(`${BASE}/api/documents`);
    expect(res.status).toBe(401);
    expect(res.type).toBe('application/json');
    expect(res.body.error).toBe('not_authenticated');
  });

  it('GET /api/documents lists the auto ID card first', async () => {
    const agent = portal();
    await signedIn(agent);
    const res = await agent.get(`${BASE}/api/documents`).expect(200);
    const docs = res.body.documents as Array<Record<string, string>>;
    expect(docs.map((d) => [d.kind, d.title])).toEqual([
      ['id_card', 'Auto ID Card'],
      ['declarations', 'Auto Declarations Page'],
      ['declarations', 'Renters Declarations Page'],
      ['policy', 'Auto Policy Packet'],
    ]);
    for (const d of docs) {
      expect(d.policyNumber).toMatch(/^DEMO-0000-\d{4}$/);
      expect(d.url).toBe(`${BASE}/api/documents/${d.id}/download`);
    }
  });

  it('downloads require a session', async () => {
    const res = await portal().get(`${BASE}/api/documents/auto-id-card/download`);
    expect(res.status).toBe(401);
  });

  it('an unknown document is a 404', async () => {
    const agent = portal();
    await signedIn(agent);
    await agent.get(`${BASE}/api/documents/nope/download`).expect(404);
  });

  it.each(MOCK_DOCUMENTS.map((d) => [d.id, d] as const))(
    'downloads %s as a valid PDF attachment',
    async (_id, doc) => {
      const agent = portal();
      await signedIn(agent);
      const res = await agent
        .get(`${BASE}/api/documents/${doc.id}/download`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(`attachment; filename="${doc.filename}"`);
      const pdf = (res.body as Buffer).toString('latin1');
      expect(pdf.startsWith('%PDF-')).toBe(true);
      expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
      expect(pdf).toContain(`(DEMO INSURANCE - ${doc.title} - TEST FIXTURE, NOT A REAL POLICY)`);
      expect(pdf).toContain(`(${doc.title})`);
    },
  );

  it('POST /logout clears the session', async () => {
    const agent = portal();
    await signedIn(agent);
    const res = await agent.post(`${BASE}/logout`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${BASE}/login`);
    await agent.get(`${BASE}/api/documents`).expect(401);
  });
});

describe('buildPdf', () => {
  it('writes an xref table whose offsets point at each object', () => {
    const pdf = buildPdf([{ text: 'Hello (world) \\ test' }], 'T').toString('latin1');
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(pdf)?.[1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
    const entries = pdf
      .slice(startxref)
      .split('\n')
      .filter((l) => / 00000 n $/.test(l));
    expect(entries).toHaveLength(6);
    entries.forEach((entry, i) => {
      const offset = Number(entry.slice(0, 10));
      expect(pdf.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    expect(pdf).toContain('(Hello \\(world\\) \\\\ test) Tj');
  });

  it('gets the content stream length right', () => {
    const pdf = buildPdf([{ text: 'abc' }]).toString('latin1');
    const length = Number(/\/Length (\d+) >>\nstream\n/.exec(pdf)?.[1]);
    const start = pdf.indexOf('stream\n') + 'stream\n'.length;
    const end = pdf.indexOf('\nendstream');
    expect(end - start).toBe(length);
  });
});

describe('mounting', () => {
  it('works under a custom basePath, with cookies scoped to it', async () => {
    const agent = portal({ basePath: '/carriers/demo/' });
    const res = await login(agent, 'demo-nomfa', 'pw', '/carriers/demo');
    expect(res.headers.location).toBe('/carriers/demo/dashboard');
    expect(cookieHeader(res).some((c) => /path=\/carriers\/demo;/i.test(c))).toBe(true);
    await agent.get(`${BASE}/login`).expect(404);
  });

  it('the router can be mounted into another Koa app alongside other routes', async () => {
    const app = new Koa();
    const router = createMockPortalRouter();
    app.use(router.routes()).use(router.allowedMethods());
    app.use((ctx) => {
      ctx.body = 'host app';
    });
    const agent = request.agent(app.callback() as unknown as Server);
    expect((await agent.get('/other')).text).toBe('host app');
    await agent.get(`${BASE}/login`).expect(200);
  });

  it('keeps state per portal instance', async () => {
    const res = await signedIn(portal());
    const session = cookieHeader(res)
      .find((c) => c.startsWith('demo_session='))
      ?.split(';')[0];
    expect(session).toBeDefined();
    // The same cookie means nothing to a second portal instance.
    await portal()
      .get(`${BASE}/dashboard`)
      .set('Cookie', session ?? '')
      .expect(302);
  });
});
