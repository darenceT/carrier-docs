import { MOCK_PORTAL_BASE_PATH } from '@carrier-docs/mock-portal';
import type { Page } from 'patchright';
import type { Logger } from 'pino';
import { createAntibot, createFingerprint, refreshFingerprint } from './antibot/index.js';
import { DemoAdapter } from './carriers/demo/adapter.js';
import { LemonadeAdapter } from './carriers/lemonade/adapter.js';
import type { CarrierAdapter } from './core/ports.js';
import { systemClock } from './infra/clock.js';
import type { Config } from './infra/config.js';
import { createCipher, type Cipher } from './infra/crypto.js';
import { SessionManager, type CarrierBrowser } from './session/manager.js';
import { SqliteSessionStore } from './store/sqlite-store.js';

/** At most this many logins wait in line for a slot (design: Capacity). */
const MAX_QUEUE = 5;
/** Default timeout for one action or navigation on a carrier page. */
const PAGE_ACTION_TIMEOUT_MS = 30_000;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

export interface Services {
  cipher: Cipher;
  sessions: SessionManager<Page>;
  close(): Promise<void>;
}

/**
 * The composition root: builds every adapter and wires it to the ports. index.ts only adds the
 * HTTP server and signals, so this is the one place that knows which implementation is used.
 */
export function createServices(config: Config, logger: Logger): Services {
  const cipher = createCipher(config.sessionKey);
  const store = new SqliteSessionStore(config.dataDir, cipher, systemClock, {
    // Kept, not deleted: a rotated key would otherwise wipe every saved session.
    onUndecryptable: () => logger.warn('a saved session could not be decrypted; ignored'),
  });
  const antibot = createAntibot(config, { logger, contextTimeoutMs: PAGE_ACTION_TIMEOUT_MS });

  // Real carriers first, so the dropdown lists them above the Demo carrier.
  const adapters: CarrierAdapter<Page>[] = [
    new LemonadeAdapter({
      pacing: antibot.forCarrier('lemonade').pacing,
      stepTimeoutMs: PAGE_ACTION_TIMEOUT_MS,
    }),
  ];
  if (config.demoCarrierEnabled) {
    // The mock portal is served by this same process (see app.ts).
    adapters.push(
      new DemoAdapter({
        baseUrl: `http://127.0.0.1:${config.port}${MOCK_PORTAL_BASE_PATH}`,
        pacing: antibot.forCarrier('demo').pacing,
      }),
    );
  }

  const browserFor = (carrierId: string): CarrierBrowser<Page> => {
    const { pool, egress } = antibot.forCarrier(carrierId);
    return {
      browserVersion: () => pool.browserVersion(),
      newContext: (options) => pool.newContext(options),
      proxy: () => egress.proxy(),
    };
  };

  const sessions = new SessionManager<Page>({
    adapters,
    browserFor,
    store,
    clock: systemClock,
    logger: logger.child({ component: 'sessions' }),
    mac: (...parts) => cipher.mac(...parts),
    createFingerprint,
    refreshFingerprint,
    limits: {
      maxSessions: config.maxSessions,
      queueWaitMs: config.queueWaitMs,
      maxQueue: MAX_QUEUE,
      mfaTimeoutMs: config.mfaTimeoutMs,
      prewarmTimeoutMs: config.prewarmTimeoutMs,
      sessionTtlMs: config.sessionTtlMs,
      documentCacheMs: config.documentCacheMs,
    },
  });

  // Expired rows are also purged on read; this keeps the file from growing between visits.
  const purge = setInterval(() => {
    store.purgeExpired().catch((err: unknown) => logger.warn({ err }, 'purge failed'));
  }, PURGE_INTERVAL_MS);
  purge.unref();

  return {
    cipher,
    sessions,
    async close() {
      clearInterval(purge);
      await sessions.close();
      await antibot.close();
      await store.close();
    },
  };
}
