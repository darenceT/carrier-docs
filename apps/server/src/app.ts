import { existsSync } from 'node:fs';
import Koa from 'koa';
import Router from '@koa/router';
import helmet from 'koa-helmet';
import serve from 'koa-static';
import { createMockPortalRouter } from '@carrier-docs/mock-portal';
import { createApi, type ApiDeps } from './api/index.js';
import { canaryRoute, type CanaryRouteOptions } from './canary/route.js';

export interface AppOptions {
  /**
   * Which build is running, sent in /healthz so an open tab can tell it was redeployed under it
   * and offer a reload (an old tab keeps running old code). Default "dev".
   */
  version?: string;
  /** Built React app to serve at /, if present. */
  webDistDir?: string;
  /** Serve the mock carrier portal at /demo-portal (the Demo carrier's "carrier site"). */
  mockPortal?: boolean;
  /** Mounts the HTTP API under /api. Omitted in tests that only need health checks. */
  /** POST /internal/canary for the scheduled workflow (token-protected). */
  canary?: CanaryRouteOptions;
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
    // Koa reports errors after the response started (e.g. a stream) here. Without a listener it
    // prints them unredacted. A browser closing its event stream is normal, not an error.
    app.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      deps.logger.error({ err }, 'unhandled app error');
    });
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

  if (options.canary) app.use(canaryRoute(options.canary));

  router.get('/healthz', (ctx) => {
    ctx.body = { ok: true, version: options.version ?? 'dev' };
  });

  app.use(router.routes()).use(router.allowedMethods());

  if (options.mockPortal) {
    const portal = createMockPortalRouter();
    app.use(portal.routes()).use(portal.allowedMethods());
  }

  if (options.webDistDir && existsSync(options.webDistDir)) {
    app.use(
      serve(options.webDistDir, {
        // Vite's hashed bundles never change; the page that names them must be re-checked on
        // every load, or a browser keeps running an old bundle after a deploy.
        setHeaders: (res, filePath) => {
          res.setHeader(
            'Cache-Control',
            /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache',
          );
        },
      }),
    );
  }

  return app;
}
