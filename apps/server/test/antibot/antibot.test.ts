import type { Browser } from 'patchright';
import { describe, expect, it, vi } from 'vitest';
import {
  BlockDetector,
  createAntibot,
  createFingerprint,
  refreshFingerprint,
  snapshotPage,
  strategyFor,
  verdictToErrorCode,
  type PageSnapshot,
} from '../../src/antibot/index.js';
import { createBrowserProvider } from '../../src/antibot/browser-provider.js';
import { createEgress, directEgress, proxyEgress } from '../../src/antibot/egress.js';
import { lightPacing, noPacing, type TypeTarget } from '../../src/antibot/pacing.js';
import type { BrowserStrategy } from '../../src/infra/config.js';
import { captureLogger } from '../browser/fakes.js';

describe('fingerprint', () => {
  it('names the real Chromium major version, honestly on Linux, in Los Angeles at 1920x1080', () => {
    expect(createFingerprint('141.0.7390.37')).toEqual({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/141.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
  });

  it('never claims to be headless', () => {
    expect(createFingerprint('141.0.1.2').userAgent).not.toMatch(/headless/i);
  });

  it('rejects a version it cannot read rather than guessing', () => {
    expect(() => createFingerprint('nightly')).toThrow();
  });

  it('keeps a saved profile, refreshing only the UA after a browser upgrade', () => {
    const saved = { ...createFingerprint('140.0.1.1'), viewport: { width: 1600, height: 900 } };
    expect(refreshFingerprint(saved, '140.0.9.9')).toBe(saved);
    const upgraded = refreshFingerprint(saved, '141.0.1.1');
    expect(upgraded.userAgent).toContain('Chrome/141.0.0.0');
    expect(upgraded.viewport).toEqual({ width: 1600, height: 900 });
  });
});

describe('egress', () => {
  it('goes out directly by default', () => {
    expect(createEgress(undefined)).toBe(directEgress);
    expect(directEgress.proxy()).toBeUndefined();
  });

  it('splits proxy credentials out of the URL for the browser', () => {
    const egress = proxyEgress('http://us%40er:p%3Ass@proxy.example:8080');
    expect(egress.kind).toBe('proxy');
    expect(egress.proxy()).toEqual({
      server: 'http://proxy.example:8080',
      username: 'us@er',
      password: 'p:ss',
    });
  });

  it('omits credentials when the URL has none', () => {
    expect(proxyEgress('http://proxy.example:8080').proxy()).toEqual({
      server: 'http://proxy.example:8080',
    });
  });
});

const target = () => {
  const calls: string[] = [];
  const t: TypeTarget = {
    click: async (o) => void calls.push(`click:${o?.delay ?? 0}`),
    fill: async (v) => void calls.push(`fill:${v}`),
    pressSequentially: async (v, o) => void calls.push(`type:${v}:${o?.delay ?? 0}`),
  };
  return { t, calls };
};

describe('pacing', () => {
  it('noPacing fills instantly', async () => {
    const { t, calls } = target();
    await noPacing.type(t, 'abc');
    expect(calls).toEqual(['fill:abc']);
  });

  it('lightPacing pauses, focuses, then types with a bounded per-key delay', async () => {
    const sleeps: number[] = [];
    const pacing = lightPacing({
      random: () => 0.5,
      sleep: async (ms) => void sleeps.push(ms),
    });
    const { t, calls } = target();
    await pacing.type(t, 'abc');
    await pacing.click(t);
    expect(sleeps).toEqual([175, 350]);
    expect(calls).toEqual(['click:60', 'type:abc:50', 'click:80']);
  });

  it('autofills a field in one go after a short pause, like a password manager', async () => {
    const sleeps: number[] = [];
    const pacing = lightPacing({ random: () => 0.5, sleep: async (ms) => void sleeps.push(ms) });
    const { t, calls } = target();
    await pacing.autofill(t, 'secret');
    expect(sleeps).toEqual([175]);
    expect(calls).toEqual(['click:60', 'fill:secret']);
    const instant = target();
    await noPacing.autofill(instant.t, 'secret');
    expect(instant.calls).toEqual(['fill:secret']);
  });

  it('stays within its bounds at the extremes', async () => {
    for (const r of [0, 0.999999]) {
      const sleeps: number[] = [];
      const { t, calls } = target();
      await lightPacing({ random: () => r, sleep: async (ms) => void sleeps.push(ms) }).type(
        t,
        'x',
      );
      expect(sleeps[0]).toBeGreaterThanOrEqual(100);
      expect(sleeps[0]).toBeLessThanOrEqual(250);
      const delay = Number(calls[1]!.split(':')[2]);
      expect(delay).toBeGreaterThanOrEqual(30);
      expect(delay).toBeLessThanOrEqual(70);
    }
  });
});

const page = (p: Partial<PageSnapshot>): PageSnapshot => ({
  url: 'https://carrier.example/login',
  status: 200,
  title: 'Log in',
  text: 'Welcome back',
  frameUrls: [],
  ...p,
});

describe('BlockDetector', () => {
  const detector = new BlockDetector({
    badCredentials: [/username or password is incorrect/i],
    blocked: [/error reference #\d+/i],
  });

  it.each<[string, Partial<PageSnapshot>, string]>([
    ['a normal page', {}, 'ok'],
    ['a 403', { status: 403 }, 'blocked'],
    ['a 429', { status: 429 }, 'blocked'],
    ['a generic block page', { text: 'Access Denied. You have been blocked.' }, 'blocked'],
    ['a carrier block rule', { text: 'Error reference #1234' }, 'blocked'],
    ['a Cloudflare interstitial', { title: 'Just a moment...' }, 'challenge'],
    [
      'a "checking your browser" page',
      { text: 'Checking your browser before access' },
      'challenge',
    ],
    [
      'a reCAPTCHA frame',
      { frameUrls: ['https://www.google.com/recaptcha/api2/anchor'] },
      'captcha',
    ],
    [
      'a Turnstile frame',
      { frameUrls: ['https://challenges.cloudflare.com/cdn-cgi/x'] },
      'captcha',
    ],
    ['a DataDome frame', { frameUrls: ['https://geo.captcha-delivery.com/captcha/'] }, 'captcha'],
    ['wrong credentials', { text: 'Your username or password is incorrect.' }, 'bad_credentials'],
  ])('classifies %s', (_label, snapshot, verdict) => {
    expect(detector.classify(page(snapshot))).toBe(verdict);
  });

  it('reports a CAPTCHA before bad credentials, so the user is not told to retype', () => {
    const snapshot = page({
      text: 'Your username or password is incorrect.',
      frameUrls: ['https://hcaptcha.com/captcha'],
    });
    expect(detector.classify(snapshot)).toBe('captcha');
  });

  it('without carrier rules, never guesses bad credentials', () => {
    expect(new BlockDetector().classify(page({ text: 'password is incorrect' }))).toBe('ok');
  });

  it('maps verdicts to stable error codes', () => {
    expect(verdictToErrorCode('blocked')).toBe('CARRIER_BLOCKED');
    expect(verdictToErrorCode('challenge')).toBe('CARRIER_CHALLENGE');
    expect(verdictToErrorCode('captcha')).toBe('CARRIER_CHALLENGE');
    expect(verdictToErrorCode('bad_credentials')).toBe('BAD_CREDENTIALS');
    expect(verdictToErrorCode('page_changed')).toBe('CARRIER_PAGE_CHANGED');
  });

  it('snapshots a page, bounding the text and tolerating a closed page', async () => {
    const snap = await snapshotPage(
      {
        url: () => 'https://x.example/',
        title: () => Promise.reject(new Error('closed')),
        innerText: async () => `  ${'a'.repeat(30_000)}  `,
        frames: () => [{ url: () => 'https://x.example/' }, { url: () => 'about:blank' }],
      },
      200,
    );
    expect(snap).toMatchObject({ url: 'https://x.example/', status: 200, title: '' });
    expect(snap.text.length).toBe(20_000);
    expect(snap.frameUrls).toEqual(['https://x.example/', 'about:blank']);
  });
});

describe('createAntibot', () => {
  const config = {
    browserStrategy: { progressive: 'patched-headless', carrier2: 'patched-headed' },
    egressProxyUrl: 'http://proxy.example:8080',
  } as const;

  it('chooses the browser per carrier from config', () => {
    expect(strategyFor(config, 'progressive')).toBe('patched-headless');
    expect(strategyFor(config, 'lemonade')).toBe('patched-headed');
    expect(strategyFor(config, 'demo')).toBe('patched-headless');
  });

  it('shares one pool per strategy and launches lazily', async () => {
    const launches: BrowserStrategy[] = [];
    const antibot = createAntibot(config, {
      logger: captureLogger().logger,
      createProvider: (strategy) => ({
        strategy,
        launch: vi.fn(async () => {
          launches.push(strategy);
          return {
            once: () => undefined,
            version: () => '141.0.0.1',
            close: async () => {},
          } as unknown as Browser;
        }),
      }),
    });
    const progressive = antibot.forCarrier('progressive');
    expect(antibot.forCarrier('demo').pool).toBe(progressive.pool);
    expect(antibot.forCarrier('lemonade').pool).not.toBe(progressive.pool);
    expect(launches).toEqual([]);
    expect(await progressive.pool.browserVersion()).toBe('141.0.0.1');
    expect(launches).toEqual(['patched-headless']);
    await antibot.close();
  });

  it('warmup launches each strategy the carriers use, once', async () => {
    const launches: BrowserStrategy[] = [];
    const antibot = createAntibot(config, {
      logger: captureLogger().logger,
      createProvider: (strategy) => ({
        strategy,
        launch: vi.fn(async () => {
          launches.push(strategy);
          return {
            once: () => undefined,
            version: () => '141.0.0.1',
            close: async () => {},
          } as unknown as Browser;
        }),
      }),
    });
    await antibot.warmup(['progressive', 'demo', 'lemonade']);
    expect(launches.sort()).toEqual(['patched-headed', 'patched-headless']);
    await antibot.warmup(['progressive']);
    expect(launches).toHaveLength(2); // already warm
    await antibot.close();
  });

  it('keeps the Demo carrier direct and unpaced; real carriers use the configured egress', () => {
    const antibot = createAntibot(config, { logger: captureLogger().logger });
    expect(antibot.forCarrier('demo').egress.proxy()).toBeUndefined();
    expect(antibot.forCarrier('demo').pacing).toBe(noPacing);
    expect(antibot.forCarrier('progressive').egress.proxy()).toEqual({
      server: 'http://proxy.example:8080',
    });
    expect(antibot.forCarrier('progressive').pacing).not.toBe(noPacing);
  });
});

describe('browser provider', () => {
  it('refuses headed mode on Linux without a display, with a clear reason', async () => {
    if (process.platform !== 'linux') return;
    const provider = createBrowserProvider('patched-headed', { env: {} });
    await expect(provider.launch()).rejects.toThrow(/Xvfb/);
  });

  it('reports its strategy', () => {
    for (const s of ['patched-headless', 'stock-headless', 'stock-new-headless'] as const) {
      expect(createBrowserProvider(s).strategy).toBe(s);
    }
  });
});
