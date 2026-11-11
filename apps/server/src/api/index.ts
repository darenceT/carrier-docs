import type {
  CarriersResponse,
  ForgetResponse,
  SessionCreated,
  StartSessionRequest,
} from '@carrier-docs/contracts';
import { bodyParser } from '@koa/bodyparser';
import Router from '@koa/router';
import type { DefaultState, Middleware, Next, ParameterizedContext } from 'koa';
import pinoLogger from 'koa-pino-logger';
import ratelimit from 'koa-ratelimit';
import type { Logger } from 'pino';
import { AppError } from '../core/errors.js';
import type { SessionService } from '../core/ports.js';
import { createAccessGate, safeEqual } from './access.js';
import { sendDocument } from './documents.js';
import { errorMiddleware, sendError } from './errors.js';
import {
  accessSchema,
  documentParams,
  mfaSchema,
  prewarmSchema,
  sessionParams,
  startSessionSchema,
} from './schemas.js';
import { streamSessionEvents } from './sse.js';

export interface RateLimitOptions {
  /** Max POST /api/access per IP per window. */
  accessMax: number;
  /** Max POST /api/sessions (logins) per IP per window. */
  loginMax: number;
  windowMs: number;
}

export interface ApiDeps {
  sessions: SessionService;
  accessCode: string;
  logger: Logger;
  /** Mark cookies Secure (production, behind TLS). */
  secureCookies: boolean;
  /** SSE heartbeat interval. Default 15 s. */
  heartbeatMs?: number;
  rateLimit?: RateLimitOptions;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  accessMax: 10,
  loginMax: 20,
  windowMs: 15 * 60 * 1000,
};

const DEFAULT_HEARTBEAT_MS = 15_000;

interface ApiState extends DefaultState {
  ownerId: string;
}

function limiter(max: number, windowMs: number, namespace: string): Middleware {
  return ratelimit({
    driver: 'memory',
    db: new Map(),
    namespace,
    max,
    duration: windowMs,
    id: (ctx) => ctx.ip,
    // Replace koa-ratelimit's plain-text body with the standard ErrorBody.
    onLimited: (ctx) => sendError(ctx, 'RATE_LIMITED'),
  });
}

/** Runs middleware in order, like koa-compose (kept local to avoid relying on a transitive dep). */
function compose(stack: Middleware[]): (ctx: ParameterizedContext, next: Next) => Promise<void> {
  return (ctx, next) => {
    const dispatch = async (i: number): Promise<void> => {
      const fn = i < stack.length ? stack[i] : next;
      if (fn) await fn(ctx, () => dispatch(i + 1));
    };
    return dispatch(0);
  };
}

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * The HTTP API (see @carrier-docs/contracts). Returns one middleware that handles every /api path
 * and passes anything else (health checks, static files) straight through.
 */
export function createApi(deps: ApiDeps): Middleware {
  const { sessions } = deps;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const limits = deps.rateLimit ?? DEFAULT_RATE_LIMIT;
  const gate = createAccessGate(deps.accessCode, deps.secureCookies);

  // Unauthenticated: only the access-code exchange.
  const open = new Router({ prefix: '/api' });
  open.post('/access', limiter(limits.accessMax, limits.windowMs, 'access'), (ctx) => {
    const { code } = accessSchema.parse(ctx.request.body);
    if (!safeEqual(code, deps.accessCode)) throw new AppError('UNAUTHORIZED');
    gate.grant(ctx);
    ctx.status = 204;
  });

  const api = new Router<ApiState>({ prefix: '/api' });

  api.get('/carriers', (ctx) => {
    const body: CarriersResponse = { carriers: sessions.listCarriers() };
    ctx.body = body;
  });

  api.post('/sessions/prewarm', async (ctx) => {
    const { carrierId } = prewarmSchema.parse(ctx.request.body);
    const { sessionId } = await sessions.prewarm(ctx.state.ownerId, carrierId);
    const body: SessionCreated = { sessionId };
    ctx.status = 202;
    ctx.body = body;
  });

  api.post('/sessions', limiter(limits.loginMax, limits.windowMs, 'login'), async (ctx) => {
    const parsed = startSessionSchema.parse(ctx.request.body);
    const input: StartSessionRequest = {
      carrierId: parsed.carrierId,
      username: parsed.username,
      password: parsed.password,
      ...(parsed.prewarmSessionId !== undefined && {
        prewarmSessionId: parsed.prewarmSessionId,
      }),
    };
    const { sessionId } = await sessions.start(ctx.state.ownerId, input);
    const body: SessionCreated = { sessionId };
    ctx.status = 202;
    ctx.body = body;
  });

  api.get('/sessions/:sessionId/events', (ctx) => {
    const { sessionId } = sessionParams.parse(ctx.params);
    streamSessionEvents(ctx, sessions, ctx.state.ownerId, sessionId, heartbeatMs);
  });

  api.post('/sessions/:sessionId/mfa', async (ctx) => {
    const { sessionId } = sessionParams.parse(ctx.params);
    const { code } = mfaSchema.parse(ctx.request.body);
    await sessions.submitMfa(ctx.state.ownerId, sessionId, code);
    ctx.status = 202;
  });

  api.get('/sessions/:sessionId/documents/:docId', async (ctx) => {
    const { sessionId, docId } = documentParams.parse(ctx.params);
    const doc = await sessions.getDocument(ctx.state.ownerId, sessionId, docId);
    sendDocument(ctx, doc);
  });

  api.delete('/me', async (ctx) => {
    const deleted = await sessions.forget(ctx.state.ownerId);
    const body: ForgetResponse = { deleted };
    ctx.body = body;
  });

  const notFound: Middleware = () => {
    throw new AppError('NOT_FOUND');
  };

  const handler = compose([
    // Logs method, URL, status and timing. Never bodies; cookies and auth headers are redacted.
    pinoLogger({ logger: deps.logger }),
    errorMiddleware(deps.logger),
    bodyParser({
      enableTypes: ['json'],
      jsonLimit: '16kb',
      jsonStrict: true,
      // Malformed, non-object or oversized JSON: the client's fault, never an INTERNAL.
      onError: (err) => {
        throw new AppError('VALIDATION_FAILED', undefined, { cause: err });
      },
    }),
    open.routes() as Middleware,
    gate.require,
    api.routes() as unknown as Middleware,
    notFound,
  ]);

  return (ctx, next) => (isApiPath(ctx.path) ? handler(ctx, next) : next());
}
