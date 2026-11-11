import { Readable } from 'node:stream';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { safeFilename } from '../../src/api/documents.js';
import { AppError } from '../../src/core/errors.js';
import { CARRIERS, KNOWN_SESSION } from './fake-session-service.js';
import { ACCESS_CODE, cookieHeader, makeHarness, setCookies } from './helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const login = { carrierId: 'demo', username: 'jane@example.com', password: 'hunter2-Secret!' };

describe('access gate', () => {
  it('accepts the right code with 204 and signed, httpOnly, SameSite=Lax cookies', async () => {
    const { app } = makeHarness();
    const res = await request(app.callback()).post('/api/access').send({ code: ACCESS_CODE });
    expect(res.status).toBe(204);
    const cookies = setCookies(res);
    for (const name of ['cd_access', 'cd_access.sig', 'cd_owner', 'cd_owner.sig']) {
      const c = cookies.get(name);
      expect(c, name).toBeDefined();
      expect(c).toMatch(/httponly/i);
      expect(c).toMatch(/samesite=lax/i);
      expect(c).not.toMatch(/;\s*secure/i);
    }
    expect(cookies.get('cd_owner')!.split(';')[0]!.split('=')[1]).toMatch(UUID_RE);
  });

  it('marks cookies Secure when secureCookies is on (behind the TLS proxy)', async () => {
    const { app } = makeHarness({ secureCookies: true });
    const res = await request(app.callback())
      .post('/api/access')
      .set('X-Forwarded-Proto', 'https')
      .send({ code: ACCESS_CODE });
    expect(res.status).toBe(204);
    expect(setCookies(res).get('cd_access')).toMatch(/;\s*secure/i);
    expect(setCookies(res).get('cd_owner')).toMatch(/;\s*secure/i);
  });

  it('keeps an existing owner ID on a repeat access', async () => {
    const { app } = makeHarness();
    const first = await request(app.callback()).post('/api/access').send({ code: ACCESS_CODE });
    const second = await request(app.callback())
      .post('/api/access')
      .set('Cookie', cookieHeader(first))
      .send({ code: ACCESS_CODE });
    const owner = (r: request.Response) => setCookies(r).get('cd_owner')!.split(';')[0];
    expect(owner(second)).toBe(owner(first));
  });

  it('rejects a wrong code (any length) with 401 UNAUTHORIZED and sets no cookie', async () => {
    const { app } = makeHarness();
    for (const code of ['wrong', `${ACCESS_CODE}x`, ACCESS_CODE.slice(0, -1)]) {
      const res = await request(app.callback()).post('/api/access').send({ code });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: { code: 'UNAUTHORIZED', message: 'Access code required.', retryable: false },
      });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('rejects API calls without the cookie', async () => {
    const { app, sessions } = makeHarness();
    const res = await request(app.callback()).get('/api/carriers');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(sessions.calls).toEqual([]);
  });

  it('rejects tampered cookies', async () => {
    const { app } = makeHarness();
    const ok = await request(app.callback()).post('/api/access').send({ code: ACCESS_CODE });
    const header = cookieHeader(ok);

    const tamperedAccess = header.replace(/cd_access=[^;]+/, 'cd_access=forged');
    const ownerUuid = '00000000-0000-4000-8000-000000000000';
    const tamperedOwner = header.replace(/cd_owner=[^;]+/, `cd_owner=${ownerUuid}`);
    const unsigned = header.replace(/cd_access\.sig=[^;]+/, 'cd_access.sig=AAAA');

    for (const cookie of [tamperedAccess, tamperedOwner, unsigned]) {
      const res = await request(app.callback()).get('/api/carriers').set('Cookie', cookie);
      expect(res.status).toBe(401);
    }
    const good = await request(app.callback()).get('/api/carriers').set('Cookie', header);
    expect(good.status).toBe(200);
  });

  it('rejects cookies signed with other keys', async () => {
    const a = makeHarness();
    const b = makeHarness();
    b.app.keys = ['a-different-key'];
    const ok = await request(a.app.callback()).post('/api/access').send({ code: ACCESS_CODE });
    const res = await request(b.app.callback())
      .get('/api/carriers')
      .set('Cookie', cookieHeader(ok));
    expect(res.status).toBe(401);
  });

  it('does not gate health checks', async () => {
    const { app } = makeHarness();
    const res = await request(app.callback()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('answers unknown /api routes with 404 NOT_FOUND once past the gate', async () => {
    const { authed } = makeHarness();
    const res = await (await authed()).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('routes', () => {
  it('GET /api/carriers lists carriers', async () => {
    const { authed } = makeHarness();
    const res = await (await authed()).get('/api/carriers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ carriers: CARRIERS });
  });

  it('POST /api/sessions/prewarm returns 202 SessionCreated, using the owner cookie', async () => {
    const { authed, sessions } = makeHarness();
    const agent = await authed();
    const res = await agent.post('/api/sessions/prewarm').send({ carrierId: 'demo' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ sessionId: 'prewarm-1' });
    const call = sessions.calls.find((c) => c.method === 'prewarm');
    expect(call).toMatchObject({ carrierId: 'demo' });
    expect(call && 'ownerId' in call && call.ownerId).toMatch(UUID_RE);
  });

  it('POST /api/sessions returns 202 SessionCreated and passes the input through', async () => {
    const { authed, sessions } = makeHarness();
    const res = await (
      await authed()
    )
      .post('/api/sessions')
      .send({ ...login, prewarmSessionId: 'prewarm-1' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ sessionId: KNOWN_SESSION });
    expect(sessions.calls.find((c) => c.method === 'start')).toMatchObject({
      input: { ...login, prewarmSessionId: 'prewarm-1' },
    });
  });

  it('the same browser keeps the same owner across calls', async () => {
    const { authed, sessions } = makeHarness();
    const agent = await authed();
    await agent.post('/api/sessions/prewarm').send({ carrierId: 'demo' });
    await agent.post('/api/sessions').send(login);
    const owners = sessions.calls.map((c) => ('ownerId' in c ? c.ownerId : undefined));
    expect(new Set(owners).size).toBe(1);
  });

  it('POST /api/sessions/:id/mfa returns 202', async () => {
    const { authed, sessions } = makeHarness();
    const res = await (
      await authed()
    )
      .post(`/api/sessions/${KNOWN_SESSION}/mfa`)
      .send({ code: '123456' });
    expect(res.status).toBe(202);
    expect(sessions.calls.find((c) => c.method === 'submitMfa')).toMatchObject({
      sessionId: KNOWN_SESSION,
      code: '123456',
    });
  });

  it('DELETE /api/me returns ForgetResponse', async () => {
    const { authed, sessions } = makeHarness();
    const res = await (await authed()).delete('/api/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 2 });
    expect(sessions.calls.some((c) => c.method === 'forget')).toBe(true);
  });
});

describe('documents', () => {
  it('streams a Uint8Array body inline with its mime type and no-store', async () => {
    const { authed } = makeHarness();
    const res = await (
      await authed()
    )
      .get(`/api/sessions/${KNOWN_SESSION}/documents/doc-1`)
      .buffer(true)
      .parse((r, cb) => {
        const parts: Buffer[] = [];
        r.on('data', (c: Buffer) => parts.push(c));
        r.on('end', () => cb(null, Buffer.concat(parts)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline; filename="id-card.pdf"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.body as Buffer).toString()).toBe('%PDF-1.4 fake');
  });

  it('streams an async-iterable body', async () => {
    const { authed, sessions } = makeHarness();
    sessions.document = {
      mimeType: 'application/pdf',
      filename: '../../etc/"evil"\r\nname.pdf',
      body: Readable.from([Buffer.from('part1-'), Buffer.from('part2')]),
    };
    const res = await (
      await authed()
    )
      .get(`/api/sessions/${KNOWN_SESSION}/documents/doc-1`)
      .buffer(true)
      .parse((r, cb) => {
        const parts: Buffer[] = [];
        r.on('data', (c: Buffer) => parts.push(c));
        r.on('end', () => cb(null, Buffer.concat(parts)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe('part1-part2');
    expect(res.headers['content-disposition']).toBe('inline; filename="evilname.pdf"');
  });

  it('never serves a non-allowlisted type inline', async () => {
    const { authed, sessions } = makeHarness();
    sessions.document = { mimeType: 'text/html', filename: 'x.html', body: new Uint8Array([60]) };
    const res = await (await authed()).get(`/api/sessions/${KNOWN_SESSION}/documents/doc-1`);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('maps a missing document to 404 NOT_FOUND', async () => {
    const { authed } = makeHarness();
    const res = await (await authed()).get(`/api/sessions/${KNOWN_SESSION}/documents/doc-2`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('safeFilename strips paths and unsafe characters', () => {
    expect(safeFilename('a/b/c.pdf')).toBe('c.pdf');
    expect(safeFilename('..\\..\\x.pdf')).toBe('x.pdf');
    expect(safeFilename('...')).toBe('document.pdf');
    expect(safeFilename('')).toBe('document.pdf');
    expect(safeFilename('a'.repeat(300)).length).toBe(100);
  });
});

describe('error mapping', () => {
  it('BUSY -> 429', async () => {
    const { authed, sessions } = makeHarness();
    sessions.failWith('start', new AppError('BUSY'));
    const res = await (await authed()).post('/api/sessions').send(login);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      error: {
        code: 'BUSY',
        message: 'All login slots are busy. Try again in a minute.',
        retryable: true,
      },
    });
  });

  it('NOT_FOUND -> 404 (e.g. MFA for an unknown session)', async () => {
    const { authed } = makeHarness();
    const res = await (await authed()).post('/api/sessions/other/mfa').send({ code: '1234' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('uses the generic message even when an AppError carries detail', async () => {
    const { authed, sessions } = makeHarness();
    sessions.failWith('prewarm', new AppError('CARRIER_UNAVAILABLE', 'selector #login missing'));
    const res = await (await authed()).post('/api/sessions/prewarm').send({ carrierId: 'demo' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('selector');
  });

  it('unknown errors -> 500 INTERNAL without leaking the message, and are logged with the code', async () => {
    const { authed, sessions, logs } = makeHarness();
    sessions.failWith('forget', new Error('sqlite exploded at /data/db.sqlite'));
    const res = await (await authed()).delete('/api/me');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL', message: 'Something went wrong on our side.', retryable: true },
    });
    expect(res.text).not.toContain('sqlite');
    expect(logs()).toContain('"code":"INTERNAL"');
  });

  const badBodies: [string, string, unknown][] = [
    ['/api/access', 'missing code', {}],
    ['/api/sessions/prewarm', 'missing carrierId', {}],
    ['/api/sessions/prewarm', 'unknown key', { carrierId: 'demo', extra: 1 }],
    ['/api/sessions/prewarm', 'bad carrierId', { carrierId: '../etc' }],
    ['/api/sessions', 'empty password', { ...login, password: '' }],
    ['/api/sessions', 'empty username', { ...login, username: '' }],
    ['/api/sessions', 'huge password', { ...login, password: 'x'.repeat(300) }],
    ['/api/sessions', 'non-string password', { ...login, password: 123 }],
    [`/api/sessions/${KNOWN_SESSION}/mfa`, 'short code', { code: '123' }],
    [`/api/sessions/${KNOWN_SESSION}/mfa`, 'long code', { code: '12345678901' }],
    [`/api/sessions/${KNOWN_SESSION}/mfa`, 'letters', { code: '12ab56' }],
    [`/api/sessions/${KNOWN_SESSION}/mfa`, 'number', { code: 123456 }],
  ];

  it.each(badBodies)('POST %s with %s -> 400 VALIDATION_FAILED', async (url, _label, body) => {
    const { authed, sessions } = makeHarness();
    const agent = await authed();
    const before = sessions.calls.length;
    const res = await agent.post(url).send(body as object);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(sessions.calls.length).toBe(before);
  });

  it('never echoes rejected values in the validation message', async () => {
    const { authed } = makeHarness();
    const res = await (
      await authed()
    )
      .post('/api/sessions')
      .send({ ...login, password: 'p'.repeat(300) });
    expect(res.body.error.message).toContain('password');
    expect(res.body.error.message).not.toContain('ppp');
  });

  it('rejects non-JSON, malformed and oversized bodies with 400', async () => {
    const { authed } = makeHarness();
    const agent = await authed();
    const form = await agent.post('/api/sessions/prewarm').type('form').send('carrierId=demo');
    expect(form.status).toBe(400);
    const malformed = await agent
      .post('/api/sessions/prewarm')
      .set('Content-Type', 'application/json')
      .send('{"carrierId":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('VALIDATION_FAILED');
    const huge = await agent
      .post('/api/sessions/prewarm')
      .send({ carrierId: 'demo', pad: 'x'.repeat(64 * 1024) });
    expect(huge.status).toBe(400);
    expect(huge.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects malformed path IDs', async () => {
    const { authed } = makeHarness();
    const res = await (
      await authed()
    )
      .post(`/api/sessions/${'a'.repeat(200)}/mfa`)
      .send({ code: '1234' });
    expect(res.status).toBe(400);
  });
});

describe('rate limiting', () => {
  const rateLimit = { accessMax: 2, loginMax: 2, windowMs: 60_000 };

  it('limits POST /api/access per IP with a RATE_LIMITED ErrorBody', async () => {
    const { app } = makeHarness({ rateLimit });
    const statuses: number[] = [];
    let last: request.Response | undefined;
    for (let i = 0; i < 3; i++) {
      last = await request(app.callback()).post('/api/access').send({ code: 'wrong' });
      statuses.push(last.status);
    }
    expect(statuses).toEqual([401, 401, 429]);
    expect(last!.body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many attempts. Wait a moment and try again.',
        retryable: true,
      },
    });
    // Even the right code is refused once limited.
    const right = await request(app.callback()).post('/api/access').send({ code: ACCESS_CODE });
    expect(right.status).toBe(429);
  });

  it('keys by client IP (X-Forwarded-For behind the proxy)', async () => {
    const { app } = makeHarness({ rateLimit });
    for (let i = 0; i < 3; i++) {
      await request(app.callback())
        .post('/api/access')
        .set('X-Forwarded-For', '10.0.0.1')
        .send({ code: 'x' });
    }
    const other = await request(app.callback())
      .post('/api/access')
      .set('X-Forwarded-For', '10.0.0.2')
      .send({ code: ACCESS_CODE });
    expect(other.status).toBe(204);
  });

  it('limits POST /api/sessions', async () => {
    const { authed, sessions } = makeHarness({ rateLimit });
    const agent = await authed();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++)
      statuses.push((await agent.post('/api/sessions').send(login)).status);
    expect(statuses).toEqual([202, 202, 429]);
    expect(sessions.calls.filter((c) => c.method === 'start')).toHaveLength(2);
    // Other routes are not limited by the login limiter.
    expect((await agent.get('/api/carriers')).status).toBe(200);
  });
});

describe('logging', () => {
  it('logs requests but never the password, username, MFA code, access code or cookies', async () => {
    const { app, authed, logs, sessions } = makeHarness();
    const agent = await authed();
    await agent.post('/api/sessions').send(login);
    await agent.post(`/api/sessions/${KNOWN_SESSION}/mfa`).send({ code: '987654' });
    sessions.failWith('start', new Error('boom'));
    await agent.post('/api/sessions').send(login);
    await request(app.callback()).post('/api/access').send({ code: ACCESS_CODE });

    const out = logs();
    expect(out).toContain('/api/sessions');
    expect(out).not.toContain(login.password);
    expect(out).not.toContain(login.username);
    expect(out).not.toContain('987654');
    expect(out).not.toContain(ACCESS_CODE);
    expect(out).not.toMatch(/cd_access=/);
    expect(out).not.toMatch(/cd_owner=/);
  });
});
