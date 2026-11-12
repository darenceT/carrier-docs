/**
 * Phase 5 reliability check with a real browser: kill Chromium in the middle of a login. The
 * session fails with a clear, retryable error, the pool relaunches, and the next login works.
 * Skipped unless RUN_BROWSER_TESTS is set. Only the local mock portal is contacted.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type BrowserServer } from '@playwright/test';
import type { SessionEvent } from '@carrier-docs/contracts';
import {
  MOCK_PORTAL_BASE_PATH,
  MOCK_PORTAL_MFA_CODE,
  createMockPortalApp,
} from '@carrier-docs/mock-portal';
import type { Browser, Page } from 'patchright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFingerprint, refreshFingerprint } from '../../src/antibot/fingerprint.js';
import { noPacing } from '../../src/antibot/pacing.js';
import { BrowserPool } from '../../src/browser/pool.js';
import { DemoAdapter } from '../../src/carriers/demo/adapter.js';
import { SessionManager } from '../../src/session/manager.js';
import { MemorySessionStore } from '../../src/store/memory-store.js';
import { captureLogger } from './fakes.js';

const clock = { now: () => Date.now() };

async function until(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!process.env.RUN_BROWSER_TESTS)('a browser crash mid-session', () => {
  let portal: http.Server;
  const servers: BrowserServer[] = [];
  let pool: BrowserPool;
  let manager: SessionManager<Page>;

  beforeAll(async () => {
    const handle = createMockPortalApp({ slowMs: 50 }).callback();
    portal = http.createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => portal.listen(0, '127.0.0.1', resolve));
    const { port } = portal.address() as AddressInfo;

    // launchServer + connect, so the test can SIGKILL the browser process.
    pool = new BrowserPool({
      launch: async () => {
        const server = await chromium.launchServer({
          headless: true,
          executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
        });
        servers.push(server);
        return (await chromium.connect(server.wsEndpoint())) as unknown as Browser;
      },
      logger: captureLogger().logger,
      contextTimeoutMs: 10_000,
    });
    manager = new SessionManager<Page>({
      adapters: [
        new DemoAdapter({
          baseUrl: `http://127.0.0.1:${port}${MOCK_PORTAL_BASE_PATH}`,
          pacing: noPacing,
        }),
      ],
      browserFor: () => ({
        browserVersion: () => pool.browserVersion(),
        newContext: (options) => pool.newContext(options),
        proxy: () => undefined,
      }),
      store: new MemorySessionStore(clock),
      clock,
      logger: captureLogger().logger,
      mac: (...parts) => parts.join('|'),
      createFingerprint,
      refreshFingerprint,
      limits: {
        maxSessions: 1,
        queueWaitMs: 5_000,
        maxQueue: 2,
        mfaTimeoutMs: 60_000,
        prewarmTimeoutMs: 60_000,
        sessionTtlMs: 3_600_000,
        documentCacheMs: 60_000,
      },
    });
  });

  afterAll(async () => {
    await manager.close();
    await pool.close();
    await Promise.allSettled(servers.map((s) => s.close()));
    await new Promise((r) => portal.close(r));
  });

  async function login(owner: string, username: string) {
    const { sessionId } = await manager.start(owner, {
      carrierId: 'demo',
      username,
      password: 'demo-password',
    });
    const events: SessionEvent[] = [];
    manager.subscribe(owner, sessionId, (e) => events.push(e));
    return { sessionId, events };
  }

  it('fails that session with CARRIER_UNAVAILABLE, relaunches, and the next login works', async () => {
    const first = await login('o1', 'alice');
    await until(() => first.events.some((e) => e.type === 'mfa_required'));

    servers[0]!.process().kill('SIGKILL');
    await until(() => pool.stats().crashes === 1);
    await manager.submitMfa('o1', first.sessionId, MOCK_PORTAL_MFA_CODE);
    await until(() => first.events.some((e) => e.type === 'failed'));
    expect(first.events.find((e) => e.type === 'failed')).toMatchObject({
      code: 'CARRIER_UNAVAILABLE',
      retryable: true,
    });

    const second = await login('o2', 'demo-nomfa');
    await until(() => second.events.some((e) => e.type === 'done' || e.type === 'failed'));
    expect(second.events.at(-1)).toEqual({ type: 'done' });
    expect(pool.stats().launches).toBe(2);
  }, 60_000);
});
