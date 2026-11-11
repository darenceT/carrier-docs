import type { Middleware } from 'koa';
import ratelimit from 'koa-ratelimit';
import { sendError } from './error-handler.js';

/**
 * Per-IP rate limit with an in-memory store (one instance, so memory is enough). When the limit is
 * hit the response is the standard ErrorBody with RATE_LIMITED, not koa-ratelimit's plain text.
 */
export function rateLimit(name: string, max: number, windowMs: number): Middleware {
  return ratelimit({
    driver: 'memory',
    db: new Map(),
    namespace: name,
    max,
    duration: windowMs,
    id: (ctx) => ctx.ip,
    onLimited: (ctx) => sendError(ctx, 'RATE_LIMITED'),
  });
}
