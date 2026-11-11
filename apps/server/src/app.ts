import { existsSync } from 'node:fs';
import Koa from 'koa';
import Router from '@koa/router';
import serve from 'koa-static';

export interface AppOptions {
  /** Built React app to serve at /, if present. */
  webDistDir?: string;
}

export function createApp(options: AppOptions = {}): Koa {
  const app = new Koa();
  const router = new Router();

  router.get('/healthz', (ctx) => {
    ctx.body = { ok: true };
  });

  app.use(router.routes()).use(router.allowedMethods());

  if (options.webDistDir && existsSync(options.webDistDir)) {
    app.use(serve(options.webDistDir));
  }

  return app;
}
