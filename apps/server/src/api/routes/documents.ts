import Router from '@koa/router';
import type { SessionService } from '../../core/ports.js';
import { documentParams } from '../schemas.js';
import { sendDocument } from '../send-document.js';
import type { ApiContext, ApiRouter } from '../types.js';

/**
 *   GET /api/sessions/:sessionId/documents/:docId   -> the document bytes (inline PDF)
 */
export function documentRoutes({ sessions }: { sessions: SessionService }): ApiRouter {
  const router: ApiRouter = new Router({ prefix: '/api/sessions' });

  router.get('/:sessionId/documents/:docId', getDocument);

  return router;

  async function getDocument(ctx: ApiContext): Promise<void> {
    const { sessionId, docId } = documentParams.parse(ctx.params);
    const doc = await sessions.getDocument(ctx.state.ownerId, sessionId, docId);
    sendDocument(ctx, doc);
  }
}
