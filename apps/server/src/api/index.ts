import type { Middleware } from 'koa';
import compose from 'koa-compose';
import pinoLogger from 'koa-pino-logger';
import { AppError } from '../core/errors.js';
import { createAccessGate } from './middleware/access-gate.js';
import { errorHandler } from './middleware/error-handler.js';
import { jsonBody } from './middleware/json-body.js';
import { accessRoutes } from './routes/access.js';
import { carrierRoutes } from './routes/carriers.js';
import { documentRoutes } from './routes/documents.js';
import { meRoutes } from './routes/me.js';
import { statusRoutes } from './routes/status.js';
import { genReqId, sessionIdProps } from './request-id.js';
import { sessionRoutes } from './routes/sessions.js';
import { DEFAULT_HEARTBEAT_MS, DEFAULT_RATE_LIMIT, type ApiDeps } from './types.js';

export type { ApiDeps, RateLimitOptions } from './types.js';
export { DEFAULT_RATE_LIMIT } from './types.js';

/**
 * The HTTP API described in @carrier-docs/contracts. Returns one middleware that handles every
 * /api path and passes anything else (health checks, static files) straight through.
 *
 * Request pipeline, in order:
 *   1. request logging     method, URL, status, timing, request ID (X-Request-Id) and session
 *                          ID; never bodies (redacting logger)
 *   2. error handler       any throw -> ErrorBody with a stable error code
 *   3. JSON body parser    JSON only, 16 kB max
 *   4. POST /api/access    the one route open without the access cookie
 *   5. access gate         401 unless signed cd_access + cd_owner cookies; sets ctx.state.ownerId
 *   6. API routes          carriers, sessions (login flow + SSE), documents, me, status
 *   7. not found           anything else under /api -> 404 NOT_FOUND
 */
export function createApi(deps: ApiDeps): Middleware {
  const { sessions, accessCode } = deps;
  const limits = deps.rateLimit ?? DEFAULT_RATE_LIMIT;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const gate = createAccessGate(accessCode, deps.secureCookies);

  const authenticatedRoutes = [
    carrierRoutes({ sessions }),
    sessionRoutes({ sessions, limits, heartbeatMs }),
    documentRoutes({ sessions }),
    meRoutes({ sessions }),
    ...(deps.status ? [statusRoutes({ status: deps.status })] : []),
  ].map((router) => router.routes() as Middleware);

  const pipeline = compose<Parameters<Middleware>[0]>([
    pinoLogger({ logger: deps.logger, genReqId, customProps: sessionIdProps }),
    errorHandler(deps.logger),
    jsonBody(),
    accessRoutes({ accessCode, gate, limits }).routes() as Middleware,
    gate.require,
    ...authenticatedRoutes,
    notFound,
  ]);

  return (ctx, next) => (isApiPath(ctx.path) ? pipeline(ctx, next) : next());
}

const notFound: Middleware = () => {
  throw new AppError('NOT_FOUND');
};

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}
