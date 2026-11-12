import { Writable } from 'node:stream';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import {
  runCanary,
  type CanaryBrowser,
  type CanaryPage,
  type CanaryReport,
} from '../../src/canary/canary.js';
import { CANARY_PATH } from '../../src/canary/route.js';
import { CARRIER_LOGIN_URLS, canaryTargets } from '../../src/canary/targets.js';
import { createFingerprint } from '../../src/antibot/index.js';
import { createLogger } from '../../src/infra/logger.js';

interface FakePageSpec {
  status?: number;
  title?: string;
  text?: string;
  frames?: readonly string[];
  gotoError?: Error;
}

function fakeBrowser(spec: FakePageSpec) {
  const calls = { goto: [] as string[], typed: 0, closed: 0, proxy: [] as unknown[] };
  const page: CanaryPage = {
    goto: async (url) => {
      calls.goto.push(url);
      if (spec.gotoError) throw spec.gotoError;
      return spec.status === undefined ? null : { status: () => spec.status! };
    },
    url: () => calls.goto.at(-1) ?? 'about:blank',
    title: async () => spec.title ?? 'Log in',
    innerText: async () => spec.text ?? 'Username Password Log in',
    frames: () => (spec.frames ?? ['about:blank']).map((u) => ({ url: () => u })),
  };
  const browser: CanaryBrowser = {
    browserVersion: async () => '148.0.7778.5',
    proxy: () => undefined,
    newContext: async (options) => {
      calls.proxy.push(options.proxy);
      return {
        newPage: async () => page,
        close: async () => {
          calls.closed += 1;
        },
      };
    },
  };
  return { browser, calls };
}

function logSink() {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  return { logger: createLogger({ level: 'trace', destination }), logs: () => chunks.join('') };
}

const run = (spec: FakePageSpec) => {
  const fake = fakeBrowser(spec);
  const sink = logSink();
  const report = runCanary([{ carrierId: 'acme', loginUrl: 'https://login.example.test/' }], {
    browserFor: () => fake.browser,
    createFingerprint,
    logger: sink.logger,
    sleep: async () => undefined,
  });
  return { report, ...fake, ...sink };
};

describe('runCanary', () => {
  it('reports a normal login page as clean, and closes the context', async () => {
    const { report, calls } = run({ status: 200 });
    const r = await report;
    expect(r.ok).toBe(true);
    expect(r.results).toEqual([
      expect.objectContaining({ carrierId: 'acme', verdict: 'clean', detail: 'ok', status: 200 }),
    ]);
    expect(calls.goto).toEqual(['https://login.example.test/']);
    expect(calls.closed).toBe(1);
  });

  it.each([
    [{ title: 'Just a moment...' }, 'challenged', 'challenge'],
    [{ frames: ['https://www.google.com/recaptcha/api2/anchor'] }, 'challenged', 'captcha'],
    [{ status: 403 }, 'blocked', 'blocked'],
    [{ text: 'Access denied. Reference #18.abc' }, 'blocked', 'blocked'],
  ] as const)('classifies %o as %s', async (spec, verdict, detail) => {
    const r = await run(spec).report;
    expect(r.ok).toBe(false);
    expect(r.results[0]).toMatchObject({ verdict, detail });
  });

  it('reports a navigation failure as error with only the error name, and still closes', async () => {
    const err = new Error('net::ERR_NAME_NOT_RESOLVED at https://login.example.test/?q=secret');
    err.name = 'TimeoutError';
    const { report, calls, logs } = run({ gotoError: err });
    const r = await report;
    expect(r.ok).toBe(false);
    expect(r.results[0]).toMatchObject({ verdict: 'error', detail: 'TimeoutError' });
    expect(JSON.stringify(r)).not.toContain('secret');
    expect(logs()).not.toContain('secret');
    expect(calls.closed).toBe(1);
  });

  it('never logs or returns page text', async () => {
    const { report, logs } = run({ text: 'Welcome back Jane Q. Example, policy 1234-5678' });
    const r = await report;
    expect(JSON.stringify(r)).not.toContain('Jane');
    expect(logs()).not.toContain('Jane');
    expect(logs()).toContain('canary result');
  });

  it('checks targets one at a time', async () => {
    let open = 0;
    let maxOpen = 0;
    const browser: CanaryBrowser = {
      browserVersion: async () => '148.0.0.0',
      proxy: () => ({ server: 'http://proxy.example.test:8080' }),
      newContext: async (options) => {
        expect(options.proxy).toEqual({ server: 'http://proxy.example.test:8080' });
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        return {
          newPage: async () =>
            fakeBrowser({})
              .browser.newContext(options)
              .then((c) => c.newPage()),
          close: async () => {
            open -= 1;
          },
        };
      },
    };
    const r = await runCanary(
      [
        { carrierId: 'a', loginUrl: 'https://a.example.test/' },
        { carrierId: 'b', loginUrl: 'https://b.example.test/' },
      ],
      {
        browserFor: () => browser,
        createFingerprint,
        logger: logSink().logger,
        sleep: async () => undefined,
      },
    );
    expect(r.results.map((x) => x.carrierId)).toEqual(['a', 'b']);
    expect(maxOpen).toBe(1);
  });
});

describe('canaryTargets', () => {
  it('only includes the Demo carrier when its portal is served', () => {
    expect(canaryTargets({ carriers: ['demo'] })).toEqual([]);
    expect(
      canaryTargets({ carriers: ['demo'], demoBaseUrl: 'http://127.0.0.1:3000/demo-portal' }),
    ).toEqual([
      expect.objectContaining({
        carrierId: 'demo',
        loginUrl: 'http://127.0.0.1:3000/demo-portal/login',
      }),
    ]);
  });

  it('maps real carriers to their public login pages', () => {
    expect(canaryTargets({ carriers: ['progressive', 'lemonade'] })).toEqual([
      { carrierId: 'progressive', loginUrl: CARRIER_LOGIN_URLS.progressive },
      { carrierId: 'lemonade', loginUrl: CARRIER_LOGIN_URLS.lemonade },
    ]);
  });
});

describe('POST /internal/canary', () => {
  const TOKEN = 'canary-token-for-tests';
  const report = (ok: boolean): CanaryReport => ({
    ok,
    checkedAt: '2026-11-11T00:00:00.000Z',
    results: [{ carrierId: 'demo', verdict: ok ? 'clean' : 'challenged', ms: 5 }],
  });
  const appWith = (run: () => Promise<CanaryReport>) =>
    createApp({ canary: { token: TOKEN, run } }).callback();

  it('rejects a missing or wrong token with 401 and does not run', async () => {
    const run = vi.fn(async () => report(true));
    const app = appWith(run);
    expect((await request(app).post(CANARY_PATH)).status).toBe(401);
    expect(
      (await request(app).post(CANARY_PATH).set('Authorization', 'Bearer wrong-token')).status,
    ).toBe(401);
    expect((await request(app).post(CANARY_PATH).set('Authorization', TOKEN)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it('returns 200 with the report when every page is clean', async () => {
    const res = await request(appWith(async () => report(true)))
      .post(CANARY_PATH)
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual(report(true));
  });

  it('returns 503 when a page is not clean, so curl -f fails the workflow', async () => {
    const res = await request(appWith(async () => report(false)))
      .post(CANARY_PATH)
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });

  it('allows only POST, and one run at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = appWith(async () => {
      await gate;
      return report(true);
    });
    expect((await request(app).get(CANARY_PATH)).status).toBe(405);

    const first = request(app)
      .post(CANARY_PATH)
      .set('Authorization', `Bearer ${TOKEN}`)
      .then((r) => r);
    await vi.waitFor(async () => {
      const second = await request(app).post(CANARY_PATH).set('Authorization', `Bearer ${TOKEN}`);
      expect(second.status).toBe(409);
    });
    release();
    expect((await first).status).toBe(200);
  });

  it('is not mounted unless configured', async () => {
    expect((await request(createApp().callback()).post(CANARY_PATH)).status).toBe(404);
  });
});
