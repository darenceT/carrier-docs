import type Router from '@koa/router';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { carrierRoutes } from '../../src/api/routes/carriers.js';
import { documentRoutes } from '../../src/api/routes/documents.js';
import { meRoutes } from '../../src/api/routes/me.js';
import { sessionRoutes } from '../../src/api/routes/sessions.js';
import { statusRoutes } from '../../src/api/routes/status.js';
import { DEFAULT_HEARTBEAT_MS, DEFAULT_RATE_LIMIT } from '../../src/api/types.js';
import { FakeSessionService } from './fake-session-service.js';
import { makeHarness } from './helpers.js';

/**
 * Phase 5 security checklist, as tests. The route list is read from the routers themselves, so a
 * route added later is covered without touching this file.
 */
function gatedRoutes(): { method: string; path: string }[] {
  const sessions = new FakeSessionService();
  const routers: Router[] = [
    carrierRoutes({ sessions }),
    sessionRoutes({ sessions, limits: DEFAULT_RATE_LIMIT, heartbeatMs: DEFAULT_HEARTBEAT_MS }),
    documentRoutes({ sessions }),
    meRoutes({ sessions }),
    statusRoutes({
      status: () => ({ since: '', sessions: { live: 0, slotsInUse: 0, waiting: 0 }, carriers: {} }),
    }),
  ] as unknown as Router[];
  return routers.flatMap((router) =>
    router.stack.flatMap((layer) =>
      layer.methods
        .filter((m) => m !== 'HEAD')
        .map((method) => ({
          method,
          // Fill path parameters with well-formed IDs, so a 401 can't be a 400 in disguise.
          path: String(layer.path)
            .replace(':sessionId', '00000000-0000-4000-8000-000000000000')
            .replace(':docId', 'doc-1')
            .replace(/\/$/, ''),
        })),
    ),
  );
}

describe('security checklist', () => {
  const routes = gatedRoutes();

  it('finds every API route (sanity check on the route discovery)', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        'GET /api/carriers',
        'POST /api/sessions',
        'POST /api/sessions/prewarm',
        'DELETE /api/me',
      ]),
    );
    expect(routes.length).toBeGreaterThanOrEqual(7);
  });

  it.each(routes)(
    '$method $path returns 401 without the access cookie',
    async ({ method, path }) => {
      const { app, sessions } = makeHarness({
        status: () => {
          throw new Error('must not run');
        },
      });
      const verb = method.toLowerCase() as 'get' | 'post' | 'delete';
      const req = request(app.callback())[verb](path);
      const res = await (verb === 'post' ? req.send({}) : req);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(sessions.calls).toEqual([]);
    },
  );

  it('sends HSTS, nosniff and a CSP on API responses', async () => {
    const { app } = makeHarness();
    const res = await request(app.callback()).get('/api/carriers');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('upgrades insecure requests only when the deployment serves HTTPS', async () => {
    const csp = async (secureCookies: boolean) =>
      (await request(makeHarness({ secureCookies }).app.callback()).get('/healthz')).headers[
        'content-security-policy'
      ] as string;
    expect(await csp(true)).toContain('upgrade-insecure-requests');
    expect(await csp(false)).not.toContain('upgrade-insecure-requests');
  });
});
