import type { Browser, BrowserContext, BrowserContextOptions } from 'patchright';
import type { Logger } from 'pino';
import type { FingerprintProfile } from '../core/ports.js';

export interface BrowserPoolOptions {
  /** Starts the browser process. Supplied by the anti-bot layer, which decides how to launch. */
  launch: () => Promise<Browser>;
  logger: Logger;
  /** Default timeout (ms) for actions and navigations inside each new context. */
  contextTimeoutMs?: number;
}

export interface NewContextOptions {
  fingerprint: FingerprintProfile;
  /** Saved storage state (cookies, local storage) from a previous run. Never logged. */
  storageState?: unknown;
  /** Egress proxy for this context, from the anti-bot layer. Credentials are never logged. */
  proxy?: { server: string; username?: string; password?: string };
}

export interface BrowserPoolStats {
  launched: boolean;
  openContexts: number;
  launches: number;
  crashes: number;
}

/**
 * One warm browser process shared by all user sessions; every session gets its own isolated
 * BrowserContext (cookies, storage and cache are per context). One process keeps memory low on a
 * small instance. If the process dies it is relaunched lazily on the next newContext().
 */
export class BrowserPool {
  private readonly launchFn: () => Promise<Browser>;
  private readonly logger: Logger;
  private readonly contextTimeoutMs: number | undefined;

  private browser: Browser | undefined;
  private launching: Promise<Browser> | undefined;
  /** Open contexts and the browser that owns each one. */
  private readonly contexts = new Map<BrowserContext, Browser>();
  private launches = 0;
  private crashes = 0;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(options: BrowserPoolOptions) {
    this.launchFn = options.launch;
    this.logger = options.logger;
    this.contextTimeoutMs = options.contextTimeoutMs;
  }

  get openContexts(): number {
    return this.contexts.size;
  }

  stats(): BrowserPoolStats {
    return {
      launched: this.browser !== undefined,
      openContexts: this.contexts.size,
      launches: this.launches,
      crashes: this.crashes,
    };
  }

  /** The running browser's version (launching it if needed), for an honest user agent. */
  async browserVersion(): Promise<string> {
    return (await this.getBrowser()).version();
  }

  /** Launch the browser now, so the first user doesn't pay the cold start. */
  async warmup(): Promise<void> {
    await this.getBrowser();
  }

  async newContext(options: NewContextOptions): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    const { fingerprint } = options;
    const contextOptions: BrowserContextOptions = {
      userAgent: fingerprint.userAgent,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      viewport: { width: fingerprint.viewport.width, height: fingerprint.viewport.height },
      deviceScaleFactor: fingerprint.deviceScaleFactor,
      acceptDownloads: true,
    };
    if (options.storageState !== undefined) {
      contextOptions.storageState = options.storageState as BrowserContextOptions['storageState'];
    }
    if (options.proxy) contextOptions.proxy = { ...options.proxy };

    const context = await browser.newContext(contextOptions);
    if (this.closed || this.browser !== browser) {
      // The pool closed or the browser died while the context was being created.
      await context.close().catch(() => undefined);
      throw new Error(this.closed ? 'Browser pool is closed' : 'Browser disconnected');
    }
    if (this.contextTimeoutMs !== undefined) context.setDefaultTimeout(this.contextTimeoutMs);
    this.contexts.set(context, browser);
    context.once('close', () => {
      this.contexts.delete(context);
    });
    return context;
  }

  /** Close every context and the browser. Idempotent; newContext() rejects afterwards. */
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = this.doClose();
    }
    return this.closing;
  }

  private async doClose(): Promise<void> {
    const pending = this.launching;
    const contexts = [...this.contexts.keys()];
    this.contexts.clear();
    await Promise.allSettled(contexts.map((c) => c.close()));
    const browser = this.browser ?? (pending ? await pending.catch(() => undefined) : undefined);
    this.browser = undefined;
    if (browser) await browser.close().catch(() => undefined);
    this.logger.info({ contextsClosed: contexts.length }, 'browser pool closed');
  }

  private getBrowser(): Promise<Browser> {
    if (this.closed) return Promise.reject(new Error('Browser pool is closed'));
    if (this.browser) return Promise.resolve(this.browser);
    if (!this.launching) this.launching = this.startLaunch();
    return this.launching;
  }

  private async startLaunch(): Promise<Browser> {
    const startedAt = Date.now();
    try {
      const browser = await this.launchFn();
      this.launches += 1;
      if (this.closed) {
        await browser.close().catch(() => undefined);
        throw new Error('Browser pool is closed');
      }
      browser.once('disconnected', () => this.onDisconnected(browser));
      this.browser = browser;
      this.logger.info({ launches: this.launches, ms: Date.now() - startedAt }, 'browser launched');
      return browser;
    } catch (err) {
      if (!this.closed) this.logger.error({ err }, 'browser launch failed');
      throw err;
    } finally {
      // Clear so the next caller retries after a failure; success is cached in this.browser.
      this.launching = undefined;
    }
  }

  private onDisconnected(browser: Browser): void {
    if (this.closed) return;
    let lost = 0;
    for (const [context, owner] of this.contexts) {
      if (owner === browser) {
        this.contexts.delete(context);
        lost += 1;
      }
    }
    if (this.browser === browser) this.browser = undefined;
    this.crashes += 1;
    this.logger.warn(
      { contextsLost: lost, crashes: this.crashes },
      'browser disconnected; will relaunch on next use',
    );
  }
}
