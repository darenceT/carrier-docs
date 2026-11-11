import Router from '@koa/router';
import type { SessionCreated, StartSessionRequest } from '@carrier-docs/contracts';
import { AppError } from '../../core/errors.js';
import type { SessionService } from '../../core/ports.js';
import { rateLimit } from '../middleware/rate-limit.js';
import {
  mfaSchema,
  prewarmSchema,
  sessionParams,
  startSessionCarrierSchema,
  startSessionSchema,
} from '../schemas.js';
import { streamSessionEvents } from '../sse.js';
import type { ApiContext, ApiRouter, RateLimitOptions } from '../types.js';

interface Deps {
  sessions: SessionService;
  limits: RateLimitOptions;
  heartbeatMs: number;
}

/**
 * The login flow.
 *
 *   POST /api/sessions/prewarm               { carrierId } -> 202 SessionCreated (rate limited)
 *   POST /api/sessions                       StartSessionRequest -> 202 SessionCreated (rate limited)
 *   GET  /api/sessions/:sessionId/events     text/event-stream of SessionEvent
 *   POST /api/sessions/:sessionId/mfa        { code } -> 202
 */
export function sessionRoutes({ sessions, limits, heartbeatMs }: Deps): ApiRouter {
  const router: ApiRouter = new Router({ prefix: '/api/sessions' });

  router.post('/prewarm', rateLimit('prewarm', limits.prewarmMax, limits.windowMs), prewarm);
  router.post('/', rateLimit('login', limits.loginMax, limits.windowMs), startSession);
  router.get('/:sessionId/events', streamEvents);
  router.post('/:sessionId/mfa', submitMfa);

  return router;

  async function prewarm(ctx: ApiContext): Promise<void> {
    const { carrierId } = prewarmSchema.parse(ctx.request.body);
    const { sessionId } = await sessions.prewarm(ctx.state.ownerId, carrierId);
    ctx.status = 202;
    ctx.body = { sessionId } satisfies SessionCreated;
  }

  async function startSession(ctx: ApiContext): Promise<void> {
    const { carrierId } = startSessionCarrierSchema.parse(ctx.request.body);
    const carrier = sessions.listCarriers().find((c) => c.id === carrierId);
    if (!carrier) throw new AppError('VALIDATION_FAILED', 'unknown carrier');
    const input = startSessionSchema(carrier.loginFields).parse(
      ctx.request.body,
    ) as StartSessionRequest;
    const { sessionId } = await sessions.start(ctx.state.ownerId, input);
    ctx.status = 202;
    ctx.body = { sessionId } satisfies SessionCreated;
  }

  function streamEvents(ctx: ApiContext): void {
    const { sessionId } = sessionParams.parse(ctx.params);
    streamSessionEvents(ctx, { sessions, ownerId: ctx.state.ownerId, sessionId, heartbeatMs });
  }

  async function submitMfa(ctx: ApiContext): Promise<void> {
    const { sessionId } = sessionParams.parse(ctx.params);
    const { code } = mfaSchema.parse(ctx.request.body);
    await sessions.submitMfa(ctx.state.ownerId, sessionId, code);
    ctx.status = 202;
  }
}
