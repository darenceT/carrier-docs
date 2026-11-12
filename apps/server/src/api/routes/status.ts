import Router from '@koa/router';
import type { StatusResponse } from '@carrier-docs/contracts';
import type { ApiContext, ApiRouter } from '../types.js';

/**
 *   GET /api/status   -> StatusResponse (behind the access code)
 *
 * Outcome counts per carrier, block rate, and p50/p95 time to first document. Counts and
 * timings only: no user, credential or document data.
 */
export function statusRoutes({ status }: { status: () => StatusResponse }): ApiRouter {
  const router: ApiRouter = new Router({ prefix: '/api' });

  router.get('/status', (ctx: ApiContext) => {
    ctx.set('Cache-Control', 'no-store');
    ctx.body = status();
  });

  return router;
}
