/**
 * Optional real-browser test of the anti-bot layer: patched headless launches, and the
 * fingerprint actually reaches the page. Skipped unless RUN_BROWSER_TESTS is set (see
 * test/browser/pool.integration.test.ts). Needs patchright's Chromium:
 *
 *   npx -w apps/server patchright install chromium   # once
 *   RUN_BROWSER_TESTS=1 npx vitest run apps/server/test/antibot
 *
 * Uses only `data:` URLs: no network, no carriers.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createAntibot, createFingerprint } from '../../src/antibot/index.js';
import { captureLogger } from '../browser/fakes.js';

describe.skipIf(!process.env.RUN_BROWSER_TESTS)('anti-bot layer with real Chromium', () => {
  const antibot = createAntibot(
    {
      browserStrategy: { progressive: 'patched-headless', carrier2: 'patched-headless' },
      egressProxyUrl: undefined,
    },
    { logger: captureLogger().logger },
  );
  afterAll(() => antibot.close());

  it('presents a coherent, non-headless identity in the page', async () => {
    const { pool } = antibot.forCarrier('progressive');
    const fingerprint = createFingerprint(await pool.browserVersion());
    const context = await pool.newContext({ fingerprint });
    const page = await context.newPage();
    await page.goto('data:text/html,<title>t</title>');
    const seen = await page.evaluate(() => ({
      ua: navigator.userAgent,
      webdriver: navigator.webdriver,
      language: navigator.language,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      width: window.innerWidth,
    }));
    expect(seen).toEqual({
      ua: fingerprint.userAgent,
      webdriver: false,
      language: 'en-US',
      tz: 'America/Los_Angeles',
      width: 1920,
    });
    await context.close();
  });
});
