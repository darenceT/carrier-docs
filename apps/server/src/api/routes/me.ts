import Router from '@koa/router';
import type { ForgetResponse } from '@carrier-docs/contracts';
import type { SessionService } from '../../core/ports.js';
import type { ApiContext, ApiRouter } from '../types.js';

/**
 *   DELETE /api/me   -> ForgetResponse ("Forget me": deletes this browser's saved sessions)
 */
export function meRoutes({ sessions }: { sessions: SessionService }): ApiRouter {
  const router: ApiRouter = new Router({ prefix: '/api' });

  router.delete('/me', forgetMe);

  return router;

  async function forgetMe(ctx: ApiContext): Promise<void> {
    const deleted = await sessions.forget(ctx.state.ownerId);
    ctx.body = { deleted } satisfies ForgetResponse;
  }
}
