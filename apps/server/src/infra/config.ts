import path from 'node:path';
import { z } from 'zod';
import { isValidSessionKey } from './crypto.js';

const BROWSER_STRATEGIES = [
  'stock-headless',
  'stock-new-headless',
  'patched-headless',
  'patched-headed',
] as const;

// Strict: canonical base64 of exactly 32 bytes, not all zeros. Lenient decoding would accept junk.
const base64Key32 = z.string().refine(isValidSessionKey, {
  message: 'must be 32 random bytes encoded as base64 (44 characters)',
});

/** Carriers whose login page the canary may open. Real carriers are opt-in (render.yaml). */
export const CANARY_CARRIERS = ['demo', 'progressive', 'lemonade'] as const;
export type CanaryCarrier = (typeof CANARY_CARRIERS)[number];

const carrierList = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.enum(CANARY_CARRIERS)));

/**
 * The values .env.example ships so `cp .env.example .env && docker compose up` works with no
 * setup. They are public, so the server refuses them on Render (which sets RENDER=true).
 */
export const LOCAL_DEV_SECRETS = {
  // Built from readable text (exactly 32 bytes) so it is plainly not a secret.
  SESSION_KEY: Buffer.from('local-dev-only-key-not-a-secret!').toString('base64'),
  ACCESS_CODE: 'local-dev-access-code',
  CANARY_TOKEN: 'local-dev-canary-token',
} as const;

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATA_DIR: z.string().min(1).default('./data'),
  SESSION_KEY: base64Key32,
  ACCESS_CODE: z.string().min(8, 'must be at least 8 characters'),
  CANARY_TOKEN: z.string().min(16, 'must be at least 16 characters'),
  // 1 on Render Starter (512 MB): measured ~170 MB per browser session (docs/spike.md).
  MAX_SESSIONS: z.coerce.number().int().min(1).max(20).default(1),
  QUEUE_WAIT_S: z.coerce.number().int().positive().default(30),
  DOCUMENT_CACHE_S: z.coerce.number().int().positive().default(600),
  MFA_TIMEOUT_S: z.coerce.number().int().positive().default(300),
  PREWARM_TIMEOUT_S: z.coerce.number().int().positive().default(120),
  SESSION_TTL_DAYS: z.coerce.number().positive().default(7),
  DEMO_CARRIER_ENABLED: bool.default(false),
  PROGRESSIVE_BROWSER: z.enum(BROWSER_STRATEGIES).default('patched-headless'),
  CARRIER2_BROWSER: z.enum(BROWSER_STRATEGIES).default('patched-headless'),
  // Local runs and tests only ever load the mock portal; Render lists the real carriers.
  CANARY_CARRIERS: carrierList.default(['demo']),
  EGRESS_PROXY_URL: z.url().optional(),
  // Skip pictures, fonts and third-party trackers on carrier pages (antibot/resources.ts). Off:
  // measured on Progressive it saved nothing (policy list 4.5 s, link 2.9 s either way) and the
  // card request took ~3 s longer. Kept as a switch for experiments.
  RESOURCE_BLOCKING: bool.default(false),
  // 'poll' if SSE arrives in bursts through the hosting proxy (design D8).
  EVENTS_TRANSPORT: z.enum(['sse', 'poll']).default('sse'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type BrowserStrategy = (typeof BROWSER_STRATEGIES)[number];

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  dataDir: string;
  sessionKey: string;
  accessCode: string;
  canaryToken: string;
  /** Login pages the canary loads (never logs in). */
  canaryCarriers: CanaryCarrier[];
  maxSessions: number;
  /** How long a login waits in line for a free browser slot. */
  queueWaitMs: number;
  /** How long fetched documents stay in memory after the browser closes. */
  documentCacheMs: number;
  mfaTimeoutMs: number;
  prewarmTimeoutMs: number;
  sessionTtlMs: number;
  demoCarrierEnabled: boolean;
  browserStrategy: Record<'progressive' | 'carrier2', BrowserStrategy>;
  egressProxyUrl: string | undefined;
  /** Skip pictures, fonts and third-party trackers on real carrier pages. */
  resourceBlocking: boolean;
  /** How the UI follows a session; see EventsTransport. */
  eventsTransport: 'sse' | 'poll';
  logLevel: string;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses and validates the environment. Fails fast with every problem listed by variable name.
 * Values are never echoed back, so a secret can't leak into startup logs.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings as unset, so `FOO=` in a .env file falls back to the default.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const c = parsed.data;
  if (cleaned.RENDER) {
    const reused = (Object.keys(LOCAL_DEV_SECRETS) as (keyof typeof LOCAL_DEV_SECRETS)[]).filter(
      (k) => c[k] === LOCAL_DEV_SECRETS[k],
    );
    if (reused.length > 0) {
      throw new ConfigError(
        reused.map((k) => `${k}: is the public value from .env.example; set a real one`),
      );
    }
  }
  return {
    env: c.NODE_ENV,
    port: c.PORT,
    dataDir: path.resolve(c.DATA_DIR),
    sessionKey: c.SESSION_KEY,
    accessCode: c.ACCESS_CODE,
    canaryToken: c.CANARY_TOKEN,
    canaryCarriers: [...new Set(c.CANARY_CARRIERS)],
    maxSessions: c.MAX_SESSIONS,
    queueWaitMs: c.QUEUE_WAIT_S * 1000,
    documentCacheMs: c.DOCUMENT_CACHE_S * 1000,
    mfaTimeoutMs: c.MFA_TIMEOUT_S * 1000,
    prewarmTimeoutMs: c.PREWARM_TIMEOUT_S * 1000,
    sessionTtlMs: c.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    demoCarrierEnabled: c.DEMO_CARRIER_ENABLED,
    browserStrategy: { progressive: c.PROGRESSIVE_BROWSER, carrier2: c.CARRIER2_BROWSER },
    egressProxyUrl: c.EGRESS_PROXY_URL,
    resourceBlocking: c.RESOURCE_BLOCKING,
    eventsTransport: c.EVENTS_TRANSPORT,
    logLevel: c.LOG_LEVEL,
  };
}
