import { existsSync } from 'node:fs';
import Koa from 'koa';
import Router from '@koa/router';
import helmet from 'koa-helmet';
import serve from 'koa-static';
import { createApi, type ApiDeps } from './api/index.js';

export interface AppOptions {
  /** Built React app to serve at /, if present. */
  webDistDir?: string;
  /** Mounts the HTTP API under /api. Omitted in tests that only need health checks. */
  api?: ApiDeps & {
    /** Keys for signing cookies (newest first, so keys can be rotated). */
    cookieKeys: string[];
  };
}

export function createApp(options: AppOptions = {}): Koa {
  const app = new Koa();
  const router = new Router();

  if (options.api) {
    const { cookieKeys, ...deps } = options.api;
    if (cookieKeys.length === 0) throw new Error('api.cookieKeys must not be empty');
    app.keys = cookieKeys;
    // Render terminates TLS, so trust X-Forwarded-Proto/-For for ctx.secure and ctx.ip.
    app.proxy = true;
    app.use(
      helmet({
        contentSecurityPolicy: {
          // Only upgrade to HTTPS where the deployment actually serves it.
          directives: { upgradeInsecureRequests: deps.secureCookies ? [] : null },
        },
      }),
    );
    // Handles /api/* only; health checks and static files pass through without the access cookie.
    app.use(createApi(deps));
  }

  router.get('/healthz', (ctx) => {
    ctx.body = { ok: true };
  });

  app.use(router.routes()).use(router.allowedMethods());

  if (options.webDistDir && existsSync(options.webDistDir)) {
    app.use(serve(options.webDistDir));
  }

  return app;
}
