import { describe, expect, it, vi } from 'vitest';
import type { FingerprintProfile } from '../../src/core/ports.js';
import { BrowserPool } from '../../src/browser/pool.js';
import { exportStorageState } from '../../src/browser/storage-state.js';
import { asBrowser, asFake, captureLogger, FakeBrowser, FakeContext } from './fakes.js';

const fingerprint: FingerprintProfile = {
  userAgent: 'Mozilla/5.0 (test)',
  locale: 'en-US',
  timezoneId: 'America/Chicago',
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(opts: { contextTimeoutMs?: number } = {}) {
  const browsers: FakeBrowser[] = [];
  const launch = vi.fn(async () => {
    const b = new FakeBrowser();
    browsers.push(b);
    return asBrowser(b);
  });
  const { lines, logger } = captureLogger();
  const pool = new BrowserPool({ launch, logger, ...opts });
  return { pool, launch, browsers, lines };
}

describe('BrowserPool', () => {
  it('launches lazily on the first newContext', async () => {
    const { pool, launch } = setup();
    expect(launch).not.toHaveBeenCalled();
    expect(pool.stats()).toEqual({ launched: false, openContexts: 0, launches: 0, crashes: 0 });

    await pool.newContext({ fingerprint });
    await pool.newContext({ fingerprint });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(pool.stats()).toEqual({ launched: true, openContexts: 2, launches: 1, crashes: 0 });
  });

  it('warmup launches now and newContext reuses it', async () => {
    const { pool, launch } = setup();
    await pool.warmup();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(pool.stats().launched).toBe(true);
    await pool.warmup();
    await pool.newContext({ fingerprint });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers share one launch', async () => {
    const gate = deferred<void>();
    const browser = new FakeBrowser();
    const launch = vi.fn(async () => {
      await gate.promise;
      return asBrowser(browser);
    });
    const pool = new BrowserPool({ launch, logger: captureLogger().logger });

    const pending = [
      pool.newContext({ fingerprint }),
      pool.newContext({ fingerprint }),
      pool.warmup(),
      pool.newContext({ fingerprint }),
    ];
    gate.resolve();
    await Promise.all(pending);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(browser.contexts).toHaveLength(3);
    expect(pool.openContexts).toBe(3);
  });

  it('a failed launch rejects all waiters and the next call retries', async () => {
    const gate = deferred<void>();
    let attempt = 0;
    const launch = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        await gate.promise;
        throw new Error('spawn failed');
      }
      return asBrowser(new FakeBrowser());
    });
    const { lines, logger } = captureLogger();
    const pool = new BrowserPool({ launch, logger });

    const a = pool.newContext({ fingerprint });
    const b = pool.newContext({ fingerprint });
    gate.resolve();
    await expect(a).rejects.toThrow('spawn failed');
    await expect(b).rejects.toThrow('spawn failed');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(pool.stats()).toMatchObject({ launched: false, launches: 0 });
    expect(lines.some((l) => l.msg === 'browser launch failed')).toBe(true);

    await expect(pool.newContext({ fingerprint })).resolves.toBeDefined();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(pool.stats()).toMatchObject({ launched: true, launches: 1, openContexts: 1 });
  });

  it('after a crash, drops the dead contexts, warns, and relaunches on the next call', async () => {
    const { pool, launch, browsers, lines } = setup();
    await pool.newContext({ fingerprint });
    await pool.newContext({ fingerprint });
    expect(pool.openContexts).toBe(2);

    browsers[0]!.crash();
    expect(pool.stats()).toEqual({ launched: false, openContexts: 0, launches: 1, crashes: 1 });
    const warn = lines.find((l) => l.level === 40);
    expect(warn).toMatchObject({ contextsLost: 2, crashes: 1 });

    await pool.newContext({ fingerprint });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(browsers[1]!.contexts).toHaveLength(1);
    expect(pool.stats()).toEqual({ launched: true, openContexts: 1, launches: 2, crashes: 1 });

    browsers[1]!.crash();
    expect(pool.stats().crashes).toBe(2);
  });

  it('a context created while its browser died is closed and rejected', async () => {
    const browser = new FakeBrowser();
    const gate = deferred<void>();
    // A context that arrives after the process died (the real API would usually reject instead).
    browser.newContext = async (o = {}) => {
      await gate.promise;
      const ctx = new FakeContext(o);
      browser.contexts.push(ctx);
      return ctx;
    };
    const pool = new BrowserPool({
      launch: async () => asBrowser(browser),
      logger: captureLogger().logger,
    });
    await pool.warmup();
    const pending = pool.newContext({ fingerprint });
    await Promise.resolve();
    browser.crash();
    gate.resolve();
    await expect(pending).rejects.toThrow('Browser disconnected');
    expect(browser.contexts[0]!.closed).toBe(true);
    expect(pool.openContexts).toBe(0);
  });

  it('removes a context from tracking when it closes', async () => {
    const { pool } = setup();
    const a = await pool.newContext({ fingerprint });
    const b = await pool.newContext({ fingerprint });
    expect(pool.openContexts).toBe(2);
    await a.close();
    expect(pool.openContexts).toBe(1);
    // A 'close' event without close() (e.g. the browser closed it) also untracks.
    asFake(b).emit('close', b);
    expect(pool.openContexts).toBe(0);
  });

  it('passes fingerprint, storage state, proxy and acceptDownloads to newContext', async () => {
    const { pool } = setup({ contextTimeoutMs: 15_000 });
    const storageState = { cookies: [{ name: 'sid', value: 'x' }], origins: [] };
    const ctx = asFake(
      await pool.newContext({
        fingerprint,
        storageState,
        proxy: { server: 'http://proxy.test:8080' },
      }),
    );
    expect(ctx.options).toEqual({
      userAgent: fingerprint.userAgent,
      locale: 'en-US',
      timezoneId: 'America/Chicago',
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      acceptDownloads: true,
      storageState,
      proxy: { server: 'http://proxy.test:8080' },
    });
    expect(ctx.defaultTimeout).toBe(15_000);

    const plain = asFake(await pool.newContext({ fingerprint }));
    expect(plain.options).not.toHaveProperty('storageState');
    expect(plain.options).not.toHaveProperty('proxy');
    expect(plain.options.acceptDownloads).toBe(true);
    expect(plain.defaultTimeout).toBe(15_000);
  });

  it('close() closes contexts and the browser, is idempotent, and later calls reject', async () => {
    const { pool, browsers, launch } = setup();
    const a = asFake(await pool.newContext({ fingerprint }));
    const b = asFake(await pool.newContext({ fingerprint }));

    await Promise.all([pool.close(), pool.close()]);
    await pool.close();
    expect(a.closed && b.closed).toBe(true);
    expect(browsers[0]!.closed).toBe(true);
    expect(pool.stats()).toEqual({ launched: false, openContexts: 0, launches: 1, crashes: 0 });

    await expect(pool.newContext({ fingerprint })).rejects.toThrow('Browser pool is closed');
    await expect(pool.warmup()).rejects.toThrow('Browser pool is closed');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('close() during an in-flight launch closes the browser once it arrives', async () => {
    const gate = deferred<void>();
    const browser = new FakeBrowser();
    const pool = new BrowserPool({
      launch: async () => {
        await gate.promise;
        return asBrowser(browser);
      },
      logger: captureLogger().logger,
    });
    const pending = pool.newContext({ fingerprint });
    const closing = pool.close();
    gate.resolve();
    await expect(pending).rejects.toThrow('Browser pool is closed');
    await closing;
    expect(browser.closed).toBe(true);
    expect(browser.contexts).toHaveLength(0);
  });

  it('never logs storage state', async () => {
    const { pool, lines } = setup();
    await pool.newContext({ fingerprint, storageState: { cookies: [{ value: 'secret-cookie' }] } });
    await pool.close();
    expect(JSON.stringify(lines)).not.toContain('secret-cookie');
  });
});

describe('exportStorageState', () => {
  it('returns the context storage state', async () => {
    const { pool } = setup();
    const ctx = await pool.newContext({ fingerprint });
    await expect(exportStorageState(ctx)).resolves.toEqual({ cookies: [], origins: [] });
  });
});
