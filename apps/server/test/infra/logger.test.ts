import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/infra/logger.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: createLogger({ level: 'debug', destination: stream }) };
}

describe('redacting logger', () => {
  it('never writes credentials, MFA codes, cookies or saved browser state', () => {
    const { lines, logger } = capture();
    logger.info(
      {
        username: 'jane@example.com',
        password: 'hunter2-secret',
        mfaCode: '482913',
        cookie: 'sid=topsecretcookie',
        storageState: { cookies: [{ value: 'storage-secret' }] },
        req: { headers: { cookie: 'a=header-cookie', authorization: 'Bearer tok-secret' } },
        login: { password: 'nested-secret', username: 'nested-user' },
      },
      'login attempt',
    );
    const out = lines.join('');
    for (const secret of [
      'jane@example.com',
      'hunter2-secret',
      '482913',
      'topsecretcookie',
      'storage-secret',
      'header-cookie',
      'tok-secret',
      'nested-secret',
      'nested-user',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[redacted]');
    expect(out).toContain('login attempt');
  });

  it('keeps error codes visible', () => {
    const { lines, logger } = capture();
    logger.warn({ code: 'BLOCKED', carrier: 'progressive' }, 'login failed');
    expect(lines.join('')).toContain('"code":"BLOCKED"');
  });
});
