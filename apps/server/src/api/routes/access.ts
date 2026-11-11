import Router from '@koa/router';
import type { Context } from 'koa';
import { AppError } from '../../core/errors.js';
import { safeEqual, type AccessGate } from '../middleware/access-gate.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { accessSchema } from '../schemas.js';
import type { RateLimitOptions } from '../types.js';

interface Deps {
  accessCode: string;
  gate: AccessGate;
  limits: RateLimitOptions;
}

/**
 * The only route that works without the access cookie.
 *
 *   POST /api/access   { code } -> 204, sets the signed cd_access and cd_owner cookies
 */
export function accessRoutes({ accessCode, gate, limits }: Deps): Router {
  const router = new Router({ prefix: '/api' });

  router.post('/access', rateLimit('access', limits.accessMax, limits.windowMs), grantAccess);

  return router;

  function grantAccess(ctx: Context): void {
    const { code } = accessSchema.parse(ctx.request.body);
    if (!safeEqual(code, accessCode)) throw new AppError('UNAUTHORIZED');
    gate.grant(ctx);
    ctx.status = 204;
  }
}
