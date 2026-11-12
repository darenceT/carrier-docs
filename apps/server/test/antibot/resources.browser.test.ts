/**
 * Resource blocking in a real Chromium against a local page. Never contacts a real site: blocked
 * requests fail inside the browser before any network. Skipped unless RUN_BROWSER_TESTS is set.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from '@playwright/test';
import type { Page } from 'patchright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BLOCKED_URL_PATTERNS, blockResources } from '../../src/antibot/resources.js';
import { captureLogger } from '../browser/fakes.js';

describe('blocked URL patterns', () => {
  it('never block the carriers, their APIs, or anti-bot services', () => {
    const joined = BLOCKED_URL_PATTERNS.join(' ');
    for (const keep of [
      'progressive',
      'lemonade',
      'cloudflare',
      'akamai',
      'icebox',
      'pdf',
      'json',
    ]) {
      expect(joined).not.toContain(keep);
    }
  });
});

describe.skipIf(!process.env.RUN_BROWSER_TESTS)('blockResources in a real browser', () => {
  let server: http.Server;
  let browser: Browser;
  let base = '';
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/app.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end('window.appRan = true;');
      }
      if (req.url?.startsWith('/pic.png')) {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end('');
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><img src="/pic.png?v=1"><script src="/app.js"></script>
<script>window.tracker = fetch('https://www.google-analytics.com/g/collect').then(() => 'sent', () => 'blocked');</script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
    browser = await chromium.launch(executablePath ? { executablePath } : {});
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  it('skips pictures and trackers, keeps the page’s own scripts, and logs the count', async () => {
    const { lines, logger } = captureLogger();
    const context = await browser.newContext();
    const page = (await context.newPage()) as unknown as Page;
    await blockResources(page, logger);
    await page.goto(base);
    expect(await page.evaluate(() => (window as unknown as { appRan?: boolean }).appRan)).toBe(
      true,
    );
    expect(
      await page.evaluate(() => (window as unknown as { tracker: Promise<string> }).tracker),
    ).toBe('blocked');
    expect(hits.some((h) => h.startsWith('/pic.png'))).toBe(false);
    expect(hits).toContain('/app.js');
    await page.close();
    // The picture and the tracker (the browser's own favicon request may add one).
    const logged = lines.find((l) => l.msg === 'resources blocked');
    expect(logged?.blocked).toBeGreaterThanOrEqual(2);
    await context.close();
  });
});
