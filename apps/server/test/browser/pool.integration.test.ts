/**
 * Optional real-browser test of the pool. Skipped unless RUN_BROWSER_TESTS is set, because CI runs
 * `npm test` before browsers are installed. To run locally:
 *
 *   npx playwright install chromium   # once
 *   RUN_BROWSER_TESTS=1 npx vitest run apps/server/test/browser
 *
 * If the installed Chromium revision doesn't match @playwright/test, point BROWSER_EXECUTABLE_PATH
 * at a chrome / chrome-headless-shell binary.
 *
 * Uses @playwright/test's Chromium as the launcher and only `data:` URLs (no network, no carriers).
 */
import { chromium, type BrowserServer } from '@playwright/test';
import type { Browser } from 'patchright';
import { afterAll, describe, expect, it } from 'vitest';
import type { FingerprintProfile } from '../../src/core/ports.js';
import { BrowserPool } from '../../src/browser/pool.js';
import { exportStorageState } from '../../src/browser/storage-state.js';
import { captureLogger } from './fakes.js';

const fingerprint: FingerprintProfile = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) carrier-docs-test',
  locale: 'en-US',
  timezoneId: 'America/New_York',
  viewport: { width: 1024, height: 768 },
  deviceScaleFactor: 1,
};

describe.skipIf(!process.env.RUN_BROWSER_TESTS)('BrowserPool with real Chromium', () => {
  // launchServer + connect (rather than launch) so the test can SIGKILL the browser process.
  const servers: BrowserServer[] = [];
  const launched: Browser[] = [];
  const pool = new BrowserPool({
    launch: async () => {
      const server = await chromium.launchServer({
        headless: true,
        executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
      });
      servers.push(server);
      // @playwright/test and patchright expose the same Browser API; the types differ nominally.
      const b = (await chromium.connect(server.wsEndpoint())) as unknown as Browser;
      launched.push(b);
      return b;
    },
    logger: captureLogger().logger,
  });

  afterAll(async () => {
    await pool.close();
    await Promise.allSettled(servers.map((s) => s.close()));
  });

  it('isolates cookies between contexts and relaunches after the browser is killed', async () => {
    await pool.warmup();
    const a = await pool.newContext({ fingerprint });
    const b = await pool.newContext({ fingerprint });
    expect(pool.openContexts).toBe(2);

    // data: URLs have an opaque origin, so set cookies through the context API.
    await a.addCookies([{ name: 'sid', value: 'only-in-a', url: 'https://example.test/' }]);
    expect(await a.cookies('https://example.test/')).toHaveLength(1);
    expect(await b.cookies('https://example.test/')).toHaveLength(0);
    const state = (await exportStorageState(a)) as { cookies: unknown[] };
    expect(state.cookies).toHaveLength(1);

    const page = await a.newPage();
    await page.goto('data:text/html,<title>ok</title>');
    expect(await page.title()).toBe('ok');
    expect(await page.evaluate(() => navigator.userAgent)).toBe(fingerprint.userAgent);

    // Kill the browser process: the pool should notice, drop its contexts and relaunch.
    const disconnected = new Promise<void>((resolve) =>
      launched[0]!.once('disconnected', () => resolve()),
    );
    servers[0]!.process().kill('SIGKILL');
    await disconnected;
    expect(pool.stats()).toMatchObject({ launched: false, openContexts: 0, crashes: 1 });

    const c = await pool.newContext({ fingerprint });
    const page2 = await c.newPage();
    await page2.goto('data:text/html,<title>again</title>');
    expect(await page2.title()).toBe('again');
    expect(pool.stats()).toMatchObject({ launched: true, openContexts: 1, launches: 2 });
  }, 60_000);
});
