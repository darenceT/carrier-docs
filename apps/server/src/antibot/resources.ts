import type { Page } from 'patchright';
import type { Logger } from 'pino';

/**
 * What a carrier page doesn't need for a login or an ID card: pictures, fonts, media and
 * third-party analytics/ads. Skipping them makes the carrier's app start faster on a small CPU,
 * and looks to the site like a browser with an ad-blocker. Never blocked: the carrier's own
 * scripts and API, and anti-bot services (Cloudflare, Akamai), which a login needs.
 *
 * Patterns use Chrome's URL blocking syntax (`*` wildcards), applied in the browser itself:
 * unlike request interception, it keeps the HTTP cache and costs no round trip per request.
 */
export const BLOCKED_URL_PATTERNS: readonly string[] = [
  // Pictures, fonts and media, by extension (with or without a query string).
  ...[
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'avif',
    'ico',
    'bmp',
    'woff',
    'woff2',
    'ttf',
    'otf',
    'eot',
    'mp4',
    'webm',
    'mp3',
  ].flatMap((ext) => [`*.${ext}`, `*.${ext}?*`]),
  // Third-party analytics, tag managers, session replay and ad pixels.
  ...[
    'google-analytics.com',
    'googletagmanager.com',
    'doubleclick.net',
    'googleadservices.com',
    'facebook.net',
    'connect.facebook.com',
    'bat.bing.com',
    'clarity.ms',
    'hotjar.com',
    'quantummetric.com',
    'contentsquare.net',
    'fullstory.com',
    'ads-twitter.com',
    'ads.linkedin.com',
    'snap.licdn.com',
    'ct.pinterest.com',
    'analytics.tiktok.com',
    'nr-data.net',
    'js-agent.newrelic.com',
  ].flatMap((host) => [`*://${host}/*`, `*://*.${host}/*`]),
];

/**
 * Turn on blocking for one page before it loads anything. Counts what was blocked and logs the
 * number when the page closes (no URLs: they can carry IDs). If the browser refuses, the page
 * simply loads everything.
 */
export async function blockResources(page: Page, logger: Logger): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: [...BLOCKED_URL_PATTERNS] });
    let blocked = 0;
    cdp.on('Network.loadingFailed', (e: { blockedReason?: string }) => {
      if (e.blockedReason === 'inspector') blocked += 1;
    });
    page.once('close', () => logger.info({ blocked }, 'resources blocked'));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'resource blocking unavailable',
    );
  }
}
