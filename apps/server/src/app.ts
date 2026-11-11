import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Koa from 'koa';
import Router from '@koa/router';
import serve from 'koa-static';

export interface AppOptions {
  /** Directory for SQLite and other persistent data (Render's disk in production). */
  dataDir: string;
  /** Built React app to serve at /, if present. */
  webDistDir?: string;
}

export function createApp(options: AppOptions): Koa {
  const app = new Koa();
  const router = new Router();

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
