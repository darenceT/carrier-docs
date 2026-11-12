import type { Middleware } from 'koa';
import { safeEqual } from '../api/middleware/access-gate.js';
import type { CanaryReport } from './canary.js';

export interface CanaryRouteOptions {
  token: string;
  run(): Promise<CanaryReport>;
}

export const CANARY_PATH = '/internal/canary';

/**
 * POST /internal/canary, for the scheduled workflow. Bearer-token protected (CANARY_TOKEN),
 * outside the reviewer access cookie. 200 when every login page is clean, 503 otherwise, so
 * `curl -f` fails the workflow run. One run at a time; a second caller gets 409.
 */
export function canaryRoute(options: CanaryRouteOptions): Middleware {
  let running = false;
  return async (ctx, next) => {
    if (ctx.path !== CANARY_PATH) return next();
    ctx.set('Cache-Control', 'no-store');
    if (ctx.method !== 'POST') {
      ctx.status = 405;
      ctx.set('Allow', 'POST');
      return;
    }
    const header = ctx.get('Authorization');
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!token || !safeEqual(token, options.token)) {
      ctx.status = 401;
      ctx.body = { error: { code: 'UNAUTHORIZED', message: 'Missing or wrong canary token.' } };
      return;
    }
    if (running) {
      ctx.status = 409;
      ctx.body = { error: { code: 'BUSY', message: 'A canary run is already in progress.' } };
      return;
    }
    running = true;
    try {
      const report = await options.run();
      ctx.status = report.ok ? 200 : 503;
      ctx.body = report;
    } finally {
      running = false;
    }
  };
}
