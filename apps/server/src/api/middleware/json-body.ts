import { bodyParser } from '@koa/bodyparser';
import type { Middleware } from 'koa';
import { AppError } from '../../core/errors.js';

/** Request bodies are tiny (a username, a password, a 6-digit code), so 16 kB is generous. */
const JSON_LIMIT = '16kb';

/**
 * Parses JSON bodies only. Malformed, non-object or oversized JSON is the client's fault, so it
 * becomes VALIDATION_FAILED (400), never INTERNAL.
 */
export function jsonBody(): Middleware {
  return bodyParser({
    enableTypes: ['json'],
    jsonLimit: JSON_LIMIT,
    jsonStrict: true,
    onError: (err) => {
      throw new AppError('VALIDATION_FAILED', undefined, { cause: err });
    },
  });
}
