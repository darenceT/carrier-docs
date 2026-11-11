import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/infra/config.js';

const validEnv = () => ({
  SESSION_KEY: randomBytes(32).toString('base64'),
  ACCESS_CODE: 'local-dev-access-code',
  CANARY_TOKEN: 'local-dev-canary-token',
});

describe('loadConfig', () => {
  it('applies defaults and converts units', () => {
    const c = loadConfig(validEnv());
    expect(c.port).toBe(3000);
    expect(c.maxSessions).toBe(1);
    expect(c.queueWaitMs).toBe(30_000);
    expect(c.documentCacheMs).toBe(600_000);
    expect(c.mfaTimeoutMs).toBe(300_000);
    expect(c.sessionTtlMs).toBe(7 * 24 * 3600 * 1000);
    expect(c.demoCarrierEnabled).toBe(false);
    expect(c.browserStrategy.progressive).toBe('patched-headless');
  });

  it('reads overrides', () => {
    const c = loadConfig({
      ...validEnv(),
      PORT: '10000',
      MAX_SESSIONS: '2',
      DEMO_CARRIER_ENABLED: 'true',
      CARRIER2_BROWSER: 'patched-headed',
    });
    expect(c.port).toBe(10000);
    expect(c.maxSessions).toBe(2);
    expect(c.demoCarrierEnabled).toBe(true);
    expect(c.browserStrategy.carrier2).toBe('patched-headed');
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ ...validEnv(), MAX_SESSIONS: '' }).maxSessions).toBe(1);
  });

  it('lists every problem by name, without echoing secret values', () => {
    const secret = 'REPLACE_WITH_32_RANDOM_BYTES_BASE64';
    try {
      loadConfig({ SESSION_KEY: secret, ACCESS_CODE: 'short', MAX_SESSIONS: 'lots' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/SESSION_KEY: must be 32 random bytes/);
      expect(msg).toMatch(/ACCESS_CODE/);
      expect(msg).toMatch(/CANARY_TOKEN/);
      expect(msg).toMatch(/MAX_SESSIONS/);
      expect(msg).not.toContain(secret);
    }
  });

  it('rejects an unknown browser strategy', () => {
    expect(() => loadConfig({ ...validEnv(), PROGRESSIVE_BROWSER: 'magic' })).toThrow(ConfigError);
  });

  it.each([
    ['junk before a valid key', '!!!!' + randomBytes(32).toString('base64')],
    ['an all-zero key', Buffer.alloc(32).toString('base64')],
    ['url-safe base64', 'A'.repeat(42) + '-_'],
    ['a 33-byte key', randomBytes(33).toString('base64')],
  ])('rejects SESSION_KEY that is %s', (_label, SESSION_KEY) => {
    expect(() => loadConfig({ ...validEnv(), SESSION_KEY })).toThrow(/SESSION_KEY/);
  });
});
