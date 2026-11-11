import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, redactDeep } from '../../src/infra/logger.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return {
    out: () => lines.join(''),
    logger: createLogger({ level: 'debug', destination: stream }),
  };
}

const expectNone = (out: string, secrets: string[]) => {
  for (const s of secrets) expect(out, `leaked ${s}`).not.toContain(s);
};

describe('redacting logger', () => {
  it('never writes credentials, MFA codes, cookies or saved browser state at the top level', () => {
    const { out, logger } = capture();
    logger.info(
      {
        username: 'jane@example.com',
        password: 'hunter2-secret',
        mfaCode: '482913',
        cookie: 'sid=topsecretcookie',
        storageState: { cookies: [{ value: 'storage-secret' }] },
        token: 'tok-top',
        canaryToken: 'canary-secret',
        egressProxyUrl: 'http://user:proxypass@proxy.example:8080',
      },
      'login attempt',
    );
    expectNone(out(), [
      'jane@example.com',
      'hunter2-secret',
      '482913',
      'topsecretcookie',
      'storage-secret',
      'tok-top',
      'canary-secret',
      'proxypass',
    ]);
    expect(out()).toContain('[redacted]');
    expect(out()).toContain('login attempt');
  });

  it('redacts at any depth and inside arrays', () => {
    const { out, logger } = capture();
    logger.info({
      job: { creds: { password: 'deep-pass', username: 'deep-user' } },
      a: { b: { c: { password: 'three-levels-down' } } },
      sessions: [{ storageState: { x: 'array-state' }, password: 'array-pass' }],
      req: {
        body: { code: '135790', password: 'body-pass' },
        headers: {
          cookie: 'a=header-cookie',
          authorization: 'Bearer auth-secret',
          'x-access-code': 'access-secret',
          'set-cookie': ['sid=set-cookie-secret'],
        },
      },
      config: { canaryToken: 'cfg-canary', sessionKey: 'cfg-key' },
    });
    expectNone(out(), [
      'deep-pass',
      'deep-user',
      'three-levels-down',
      'array-state',
      'array-pass',
      '135790',
      'body-pass',
      'header-cookie',
      'auth-secret',
      'access-secret',
      'set-cookie-secret',
      'cfg-canary',
      'cfg-key',
    ]);
  });

  it('redacts a top-level or nested `code` unless it is a stable error code', () => {
    const { out, logger } = capture();
    logger.info({ code: '246810' }, 'mfa submitted');
    logger.info({ step: { code: '112233' } });
    expectNone(out(), ['246810', '112233']);
  });

  it('keeps stable error codes visible', () => {
    const { out, logger } = capture();
    logger.warn({ code: 'CARRIER_BLOCKED', carrier: 'progressive' }, 'login failed');
    logger.warn({ error: { code: 'MFA_TIMEOUT' } });
    expect(out()).toContain('"code":"CARRIER_BLOCKED"');
    expect(out()).toContain('"code":"MFA_TIMEOUT"');
    expect(out()).toContain('"carrier":"progressive"');
  });

  it('redacts child-logger bindings too', () => {
    const { out, logger } = capture();
    logger.child({ sessionId: 's-1', password: 'bound-secret' }).info('step');
    logger
      .child({ requestId: 'r-1' })
      .child({ creds: { password: 'grandchild-secret' } })
      .info('x');
    expectNone(out(), ['bound-secret', 'grandchild-secret']);
    expect(out()).toContain('"requestId":"r-1"');
    expect(out()).toContain('"sessionId":"s-1"');
  });

  it('matches keys regardless of case, dashes and underscores', () => {
    const r = redactDeep({ ACCESS_CODE: 'a', 'Set-Cookie': 'b', mfa_code: 'c', Ok: 'd' });
    expect(r).toEqual({
      ACCESS_CODE: '[redacted]',
      'Set-Cookie': '[redacted]',
      mfa_code: '[redacted]',
      Ok: 'd',
    });
  });

  it('survives circular references', () => {
    const o: Record<string, unknown> = { password: 'loop-secret' };
    o.self = o;
    const { out, logger } = capture();
    logger.info(o);
    expectNone(out(), ['loop-secret']);
    expect(out()).toContain('[circular]');
  });
});
