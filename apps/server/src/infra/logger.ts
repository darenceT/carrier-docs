import { pino, type DestinationStream, type Logger } from 'pino';

/**
 * Paths pino replaces with "[redacted]". Covers credentials, MFA codes, cookies, saved browser
 * state and request headers. Note: the plain key `code` is NOT redacted, because error codes
 * (e.g. BLOCKED) must stay visible; MFA codes are always logged under `mfaCode`.
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'username',
  '*.username',
  'credentials',
  '*.credentials',
  'mfaCode',
  '*.mfaCode',
  'cookie',
  '*.cookie',
  'cookies',
  '*.cookies',
  'storageState',
  '*.storageState',
  'accessCode',
  '*.accessCode',
  'sessionKey',
  '*.sessionKey',
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
];

export interface LoggerOptions {
  level?: string;
  /** Where to write. Defaults to stdout; tests pass a stream to inspect output. */
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? 'info',
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      base: { service: 'carrier-docs' },
    },
    options.destination,
  );
}
