import { pino, type DestinationStream, type Logger } from 'pino';
import { ERROR_CODES } from '../core/errors.js';

export const REDACTED = '[redacted]';

/**
 * Keys whose values are never logged, at any depth. Matching ignores case, '-' and '_', so
 * `x-access-code`, `accessCode` and `ACCESS_CODE` are all caught.
 */
const SENSITIVE_KEYS = new Set(
  [
    'password',
    'passwd',
    'username',
    'credentials',
    'creds',
    'mfaCode',
    'otp',
    'verificationCode',
    'cookie',
    'cookies',
    'set-cookie',
    'storageState',
    'accessCode',
    'x-access-code',
    'sessionKey',
    'cookieKey',
    'authorization',
    'token',
    'accessToken',
    'refreshToken',
    'canaryToken',
    'secret',
    'apiKey',
    'egressProxyUrl',
    'proxyUrl',
  ].map(normalize),
);

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);
const MAX_DEPTH = 10;

function normalize(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/**
 * `code` is ambiguous: an MFA code must never be logged, but a stable error code (e.g.
 * CARRIER_BLOCKED) must stay visible. Keep it only when it is one of ERROR_CODES.
 */
function isSafeCode(value: unknown): boolean {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Returns a copy with sensitive values replaced, at any depth, inside plain objects and arrays.
 * Other objects (Errors, HTTP requests) are left to pino's serializers and path redaction below.
 */
export function redactDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_DEPTH) return '[too deep]';
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return value.map((v) => redactDeep(v, depth + 1, seen));
  }
  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const nk = normalize(k);
    if (SENSITIVE_KEYS.has(nk) || (nk === 'code' && !isSafeCode(v))) {
      out[k] = REDACTED;
    } else {
      out[k] = redactDeep(v, depth + 1, seen);
    }
  }
  return out;
}

/**
 * Path redaction for objects that serializers build (pino-http's req/res), which the deep pass
 * above doesn't see because it runs before serialization.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-access-code"]',
  'req.body',
  'res.headers["set-cookie"]',
  'err.config',
];

export interface LoggerOptions {
  level?: string;
  /** Where to write. Defaults to stdout; tests pass a stream to inspect output. */
  destination?: DestinationStream;
}

/**
 * pino skips the bindings formatter for child loggers, so redact `child()` bindings ourselves,
 * on every child at any depth.
 */
function redactChildBindings(logger: Logger): Logger {
  const baseChild = logger.child;
  const wrapped = function (this: Logger, bindings: Record<string, unknown>, opts?: object) {
    const safe = redactDeep(bindings) as Record<string, unknown>;
    return redactChildBindings(baseChild.call(this, safe, opts) as unknown as Logger);
  };
  logger.child = wrapped as unknown as Logger['child'];
  return logger;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const logger = pino(
    {
      level: options.level ?? 'info',
      redact: { paths: REDACT_PATHS, censor: REDACTED },
      base: { service: 'carrier-docs' },
      formatters: {
        log: (obj) => redactDeep(obj) as Record<string, unknown>,
        bindings: (bindings) => redactDeep(bindings) as Record<string, unknown>,
      },
    },
    options.destination,
  );
  return redactChildBindings(logger);
}
