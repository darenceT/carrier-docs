import type { Router } from '@koa/router';
import type { DefaultContext, DefaultState, ParameterizedContext } from 'koa';
import type { EventsTransport, StatusResponse } from '@carrier-docs/contracts';
import type { Logger } from 'pino';
import type { SessionService } from '../core/ports.js';

export interface RateLimitOptions {
  /** Max POST /api/access per IP per window. */
  accessMax: number;
  /** Max POST /api/sessions (logins) per IP per window. */
  loginMax: number;
  /**
   * Max POST /api/sessions/prewarm per IP per window. Each pre-warm holds a browser slot for up
   * to 2 minutes, so without a limit one client could keep the cap full with pre-warms.
   */
  prewarmMax: number;
  windowMs: number;
}

/** Everything the API needs, injected by createApp. */
export interface ApiDeps {
  sessions: SessionService;
  accessCode: string;
  logger: Logger;
  /** Mark cookies Secure (production, behind TLS). */
  secureCookies: boolean;
  /** SSE heartbeat interval. Default 15 s. */
  heartbeatMs?: number;
  rateLimit?: RateLimitOptions;
  /** Mounts GET /api/status when given. */
  status?: () => StatusResponse;
  /** Advertised in GET /api/carriers; the UI follows sessions this way. Default SSE. */
  eventsTransport?: EventsTransport;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  accessMax: 10,
  loginMax: 20,
  prewarmMax: 30,
  windowMs: 15 * 60 * 1000,
};

export const DEFAULT_HEARTBEAT_MS = 15_000;

/** State set by the access gate on every authenticated request. */
export interface ApiState extends DefaultState {
  /** The browser's owner ID (from the signed cd_owner cookie). */
  ownerId: string;
}

/** Context type for authenticated route handlers: Koa's context plus the router's path params. */
export type ApiContext = ParameterizedContext<ApiState> & { params: Record<string, string> };

/** A router for authenticated routes, mounted under /api. */
export type ApiRouter = Router<ApiState, DefaultContext>;
