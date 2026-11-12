import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, LOCAL_DEV_SECRETS, loadConfig } from '../../src/infra/config.js';

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
    expect(c.resourceBlocking).toBe(false);
    expect(c.browserStrategy.progressive).toBe('patched-headless');
  });

  it('reads overrides', () => {
    const c = loadConfig({
      ...validEnv(),
      PORT: '10000',
      MAX_SESSIONS: '2',
      DEMO_CARRIER_ENABLED: 'true',
      CARRIER2_BROWSER: 'patched-headed',
      RESOURCE_BLOCKING: 'true',
    });
    expect(c.resourceBlocking).toBe(true);
    expect(c.port).toBe(10000);
    expect(c.maxSessions).toBe(2);
    expect(c.demoCarrierEnabled).toBe(true);
    expect(c.browserStrategy.carrier2).toBe('patched-headed');
  });

  it('follows sessions over SSE unless EVENTS_TRANSPORT says poll', () => {
    expect(loadConfig(validEnv()).eventsTransport).toBe('sse');
    expect(loadConfig({ ...validEnv(), EVENTS_TRANSPORT: 'poll' }).eventsTransport).toBe('poll');
    expect(() => loadConfig({ ...validEnv(), EVENTS_TRANSPORT: 'ws' })).toThrow(/EVENTS_TRANSPORT/);
  });

  it('canary loads only the mock portal unless real carriers are listed', () => {
    expect(loadConfig(validEnv()).canaryCarriers).toEqual(['demo']);
    expect(
      loadConfig({ ...validEnv(), CANARY_CARRIERS: 'progressive, lemonade,progressive' })
        .canaryCarriers,
    ).toEqual(['progressive', 'lemonade']);
    expect(() => loadConfig({ ...validEnv(), CANARY_CARRIERS: 'demo,acme' })).toThrow(
      /CANARY_CARRIERS/,
    );
  });

  it('starts from .env.example as is, so the README quick start works', () => {
    const example = Object.fromEntries(
      readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    expect(() => loadConfig(example)).not.toThrow();
    for (const [k, v] of Object.entries(LOCAL_DEV_SECRETS)) expect(example[k]).toBe(v);
  });

  it('refuses the public .env.example secrets on Render, naming only the variables', () => {
    expect(() => loadConfig({ ...LOCAL_DEV_SECRETS })).not.toThrow();
    try {
      loadConfig({ ...validEnv(), ...LOCAL_DEV_SECRETS, RENDER: 'true' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).problems).toHaveLength(3);
      expect((err as ConfigError).problems.map((p) => p.split(':')[0])).toEqual([
        'SESSION_KEY',
        'ACCESS_CODE',
        'CANARY_TOKEN',
      ]);
      expect((err as Error).message).not.toContain(LOCAL_DEV_SECRETS.ACCESS_CODE);
    }
    const real = {
      SESSION_KEY: randomBytes(32).toString('base64'),
      ACCESS_CODE: randomBytes(12).toString('hex'),
      CANARY_TOKEN: randomBytes(12).toString('hex'),
    };
    expect(() => loadConfig({ ...real, RENDER: 'true' })).not.toThrow();
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
