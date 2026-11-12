import Router from '@koa/router';
import type { CarriersResponse, EventsTransport } from '@carrier-docs/contracts';
import type { SessionService } from '../../core/ports.js';
import type { ApiContext, ApiRouter } from '../types.js';

/**
 *   GET /api/carriers   -> CarriersResponse
 */
export function carrierRoutes({
  sessions,
  eventsTransport,
}: {
  sessions: SessionService;
  eventsTransport?: EventsTransport;
}): ApiRouter {
  const router: ApiRouter = new Router({ prefix: '/api' });

  router.get('/carriers', listCarriers);

  return router;

  function listCarriers(ctx: ApiContext): void {
    ctx.body = {
      carriers: sessions.listCarriers(),
      ...(eventsTransport && { eventsTransport }),
    } satisfies CarriersResponse;
  }
}
