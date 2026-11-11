import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Koa from 'koa';
import Router from '@koa/router';
import helmet from 'koa-helmet';
import serve from 'koa-static';
import { createApi, type ApiDeps } from './api/index.js';

export interface AppOptions {
  /** Directory for SQLite and other persistent data (Render's disk in production). */
  dataDir: string;
  /** Built React app to serve at /, if present. */
  webDistDir?: string;
  /** Mounts the HTTP API under /api. Omitted in tests that only need health checks. */
  api?: ApiDeps & {
    /** Keys for signing cookies (newest first, so keys can be rotated). */
    cookieKeys: string[];
  };
}

export function createApp(options: AppOptions): Koa {
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

  // Phase 1 deploy check: proves the node user can write to the persistent disk.
  // Temporary; remove once the SQLite SessionStore exercises the disk (Phase 3).
  router.get('/healthz/disk', async (ctx) => {
    const file = path.join(options.dataDir, `.write-check-${randomUUID()}`);
    const expected = `ok ${Date.now()}`;
    try {
      await mkdir(options.dataDir, { recursive: true });
      await writeFile(file, expected, 'utf8');
      const actual = await readFile(file, 'utf8');
      await rm(file, { force: true });
      ctx.body = { ok: actual === expected, dataDir: options.dataDir };
    } catch (err) {
      ctx.status = 500;
      ctx.body = {
        ok: false,
        dataDir: options.dataDir,
        error: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN',
      };
    }
  });

  app.use(router.routes()).use(router.allowedMethods());

  if (options.webDistDir && existsSync(options.webDistDir)) {
    app.use(serve(options.webDistDir));
  }

  return app;
}
