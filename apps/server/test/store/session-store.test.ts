import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SavedSession, SessionStore } from '../../src/core/ports.js';
import { ManualClock } from '../../src/infra/clock.js';
import { createCipher } from '../../src/infra/crypto.js';
import { MemorySessionStore } from '../../src/store/memory-store.js';
import { SqliteSessionStore } from '../../src/store/sqlite-store.js';

const HOUR = 3_600_000;

const session = (marker = 'cookie-value-123'): SavedSession => ({
  carrierId: 'progressive',
  storageState: { cookies: [{ name: 'sid', value: marker }], origins: [] },
  fingerprint: {
    userAgent: 'Mozilla/5.0 test',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  },
  savedAt: 0,
});

let dataDir: string;
let clock: ManualClock;
const key = randomBytes(32).toString('base64');

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'carrier-docs-store-'));
  clock = new ManualClock(1_000_000);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const implementations: Array<[string, () => SessionStore]> = [
  ['MemorySessionStore', () => new MemorySessionStore(clock)],
  ['SqliteSessionStore', () => new SqliteSessionStore(dataDir, createCipher(key), clock)],
];

describe.each(implementations)('%s contract', (_name, make) => {
  let store: SessionStore;
  beforeEach(() => {
    store = make();
  });
  afterEach(async () => {
    await store.close();
  });

  it('stores and returns a session', async () => {
    await store.put('k1', 'owner-a', session(), HOUR);
    expect(await store.get('k1')).toEqual(session());
    expect(await store.get('missing')).toBeUndefined();
  });

  it('overwrites on put with the same key', async () => {
    await store.put('k1', 'owner-a', session('old'), HOUR);
    await store.put('k1', 'owner-a', session('new'), HOUR);
    expect(await store.get('k1')).toEqual(session('new'));
  });

  it('expires after the TTL', async () => {
    await store.put('k1', 'owner-a', session(), HOUR);
    clock.advance(HOUR - 1);
    expect(await store.get('k1')).toBeDefined();
    clock.advance(1);
    expect(await store.get('k1')).toBeUndefined();
  });

  it('deletes one key', async () => {
    await store.put('k1', 'owner-a', session(), HOUR);
    await store.delete('k1');
    expect(await store.get('k1')).toBeUndefined();
  });

  it('forgets everything for one owner only', async () => {
    await store.put('k1', 'owner-a', session(), HOUR);
    await store.put('k2', 'owner-a', session(), HOUR);
    await store.put('k3', 'owner-b', session(), HOUR);
    expect(await store.deleteByOwner('owner-a')).toBe(2);
    expect(await store.get('k1')).toBeUndefined();
    expect(await store.get('k3')).toBeDefined();
  });

  it('purges expired rows', async () => {
    await store.put('short', 'owner-a', session(), HOUR);
    await store.put('long', 'owner-a', session(), 10 * HOUR);
    clock.advance(2 * HOUR);
    expect(await store.purgeExpired()).toBe(1);
    expect(await store.get('long')).toBeDefined();
  });
});

describe('SqliteSessionStore at rest', () => {
  it('keeps sessions across restarts', async () => {
    const a = new SqliteSessionStore(dataDir, createCipher(key), clock);
    await a.put('k1', 'owner-a', session(), HOUR);
    await a.close();
    const b = new SqliteSessionStore(dataDir, createCipher(key), clock);
    expect(await b.get('k1')).toEqual(session());
    await b.close();
  });

  it('stores only ciphertext on disk', async () => {
    const s = new SqliteSessionStore(dataDir, createCipher(key), clock);
    await s.put('k1', 'owner-a', session('very-secret-cookie'), HOUR);
    await s.close();
    const raw = new Database(path.join(dataDir, 'sessions.db'), { readonly: true });
    const rows = raw.prepare('SELECT blob FROM sessions').all() as Array<{ blob: string }>;
    raw.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blob.startsWith('v1.')).toBe(true);
    expect(rows[0]?.blob).not.toContain('very-secret-cookie');
  });

  it('treats a row it cannot decrypt (rotated key) as missing and removes it', async () => {
    const a = new SqliteSessionStore(dataDir, createCipher(key), clock);
    await a.put('k1', 'owner-a', session(), HOUR);
    await a.close();
    const b = new SqliteSessionStore(
      dataDir,
      createCipher(randomBytes(32).toString('base64')),
      clock,
    );
    expect(await b.get('k1')).toBeUndefined();
    expect(await b.purgeExpired()).toBe(0);
    await b.close();
  });
});
