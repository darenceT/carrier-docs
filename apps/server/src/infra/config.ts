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

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATA_DIR: z.string().min(1).default('./data'),
  SESSION_KEY: base64Key32,
  ACCESS_CODE: z.string().min(8, 'must be at least 8 characters'),
  CANARY_TOKEN: z.string().min(16, 'must be at least 16 characters'),
  MAX_SESSIONS: z.coerce.number().int().min(1).max(20).default(3),
  IDLE_TIMEOUT_S: z.coerce.number().int().positive().default(180),
  MFA_TIMEOUT_S: z.coerce.number().int().positive().default(300),
  PREWARM_TIMEOUT_S: z.coerce.number().int().positive().default(120),
  SESSION_TTL_DAYS: z.coerce.number().positive().default(7),
  DEMO_CARRIER_ENABLED: bool.default(false),
  PROGRESSIVE_BROWSER: z.enum(BROWSER_STRATEGIES).default('patched-headless'),
  CARRIER2_BROWSER: z.enum(BROWSER_STRATEGIES).default('patched-headless'),
  EGRESS_PROXY_URL: z.url().optional(),
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
  maxSessions: number;
  idleTimeoutMs: number;
  mfaTimeoutMs: number;
  prewarmTimeoutMs: number;
  sessionTtlMs: number;
  demoCarrierEnabled: boolean;
  browserStrategy: Record<'progressive' | 'carrier2', BrowserStrategy>;
  egressProxyUrl: string | undefined;
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
  return {
    env: c.NODE_ENV,
    port: c.PORT,
    dataDir: path.resolve(c.DATA_DIR),
    sessionKey: c.SESSION_KEY,
    accessCode: c.ACCESS_CODE,
    canaryToken: c.CANARY_TOKEN,
    maxSessions: c.MAX_SESSIONS,
    idleTimeoutMs: c.IDLE_TIMEOUT_S * 1000,
    mfaTimeoutMs: c.MFA_TIMEOUT_S * 1000,
    prewarmTimeoutMs: c.PREWARM_TIMEOUT_S * 1000,
    sessionTtlMs: c.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    demoCarrierEnabled: c.DEMO_CARRIER_ENABLED,
    browserStrategy: { progressive: c.PROGRESSIVE_BROWSER, carrier2: c.CARRIER2_BROWSER },
    egressProxyUrl: c.EGRESS_PROXY_URL,
    logLevel: c.LOG_LEVEL,
  };
}
