import type { Logger } from 'pino';
import { BrowserPool } from '../browser/pool.js';
import type { BrowserStrategy, Config } from '../infra/config.js';
import { createBrowserProvider, type BrowserProvider } from './browser-provider.js';
import { createEgress, type EgressProvider } from './egress.js';
import { lightPacing, noPacing, type Pacing } from './pacing.js';

export { BlockDetector, snapshotPage, verdictToErrorCode } from './block-detector.js';
export type { BlockVerdict, CarrierBlockRules, PageSnapshot } from './block-detector.js';
export { createFingerprint, refreshFingerprint } from './fingerprint.js';
export type { EgressProvider } from './egress.js';
export type { Pacing, TypeTarget } from './pacing.js';

/**
 * Everything a session for one carrier needs from the anti-bot layer. Carrier adapters get a
 * page from it and a Pacing to type with; they never choose a browser or an IP themselves.
 */
export interface CarrierAntibot {
  strategy: BrowserStrategy;
  /** Shared by every carrier on the same strategy: one browser process per strategy. */
  pool: BrowserPool;
  egress: EgressProvider;
  pacing: Pacing;
  /** Skip pictures, fonts and trackers on this carrier's pages (see resources.ts). */
  blockResources: boolean;
}

export interface Antibot {
  forCarrier(carrierId: string): CarrierAntibot;
  /** Launch the browsers these carriers use now, so the first login doesn't pay the cold start. */
  warmup(carrierIds: readonly string[]): Promise<void>;
  /** Close every browser this layer launched. */
  close(): Promise<void>;
}

export type AntibotConfig = Pick<Config, 'browserStrategy' | 'egressProxyUrl'> &
  Partial<Pick<Config, 'resourceBlocking'>>;

export interface AntibotOptions {
  logger: Logger;
  /** Default timeout for actions inside each context. */
  contextTimeoutMs?: number;
  /** Override how browsers launch (tests). */
  createProvider?: (strategy: BrowserStrategy) => BrowserProvider;
}

/** The Demo carrier's mock portal runs in this process, so it never needs stealth or pacing. */
const DEMO_CARRIER_ID = 'demo';

/**
 * Per-carrier selection from config (design: "the strategy is chosen per carrier in config").
 * Carriers without their own setting, the Demo carrier included, use patched headless, the
 * spike's choice for D2.
 */
export function strategyFor(config: AntibotConfig, carrierId: string): BrowserStrategy {
  if (carrierId === 'progressive') return config.browserStrategy.progressive;
  if (carrierId === 'lemonade') return config.browserStrategy.carrier2;
  return 'patched-headless';
}

export function createAntibot(config: AntibotConfig, options: AntibotOptions): Antibot {
  const createProvider = options.createProvider ?? ((s) => createBrowserProvider(s));
  const egress = createEgress(config.egressProxyUrl);
  const pools = new Map<BrowserStrategy, BrowserPool>();

  const poolFor = (strategy: BrowserStrategy): BrowserPool => {
    let pool = pools.get(strategy);
    if (!pool) {
      const provider = createProvider(strategy);
      pool = new BrowserPool({
        launch: () => provider.launch(),
        logger: options.logger.child({ strategy }),
        contextTimeoutMs: options.contextTimeoutMs,
      });
      pools.set(strategy, pool);
    }
    return pool;
  };

  return {
    forCarrier(carrierId) {
      const strategy = strategyFor(config, carrierId);
      const isDemo = carrierId === DEMO_CARRIER_ID;
      return {
        strategy,
        pool: poolFor(strategy),
        // The mock portal is local: a proxy would only add latency and cost.
        egress: isDemo ? createEgress(undefined) : egress,
        pacing: isDemo ? noPacing : lightPacing(),
        // The mock portal is tiny and local: nothing to gain.
        blockResources: !isDemo && config.resourceBlocking !== false,
      };
    },
    async warmup(carrierIds) {
      const unique = new Set(carrierIds.map((id) => poolFor(strategyFor(config, id))));
      await Promise.allSettled([...unique].map((p) => p.warmup()));
    },
    async close() {
      await Promise.allSettled([...pools.values()].map((p) => p.close()));
    },
  };
}
