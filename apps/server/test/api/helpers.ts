import { Writable } from 'node:stream';
import type Koa from 'koa';
import request from 'supertest';
import type { ApiDeps } from '../../src/api/index.js';
import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/infra/logger.js';
import { FakeSessionService } from './fake-session-service.js';

export const ACCESS_CODE = 'open-sesame-123';

export interface Harness {
  app: Koa;
  sessions: FakeSessionService;
  /** Everything the logger wrote, as one string. */
  logs: () => string;
  /** A supertest agent that has already passed the access gate (cookies kept). */
  authed: () => Promise<ReturnType<typeof request.agent>>;
}

export function makeHarness(overrides: Partial<ApiDeps> = {}): Harness {
  const sessions = new FakeSessionService();
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  const logger = createLogger({ level: 'trace', destination });
  const app = createApp({
    api: {
      sessions,
      accessCode: ACCESS_CODE,
      logger,
      secureCookies: false,
      cookieKeys: ['test-cookie-key-1'],
      ...overrides,
    },
  });
  return {
    app,
    sessions,
    logs: () => chunks.join(''),
    authed: async () => {
      const agent = request.agent(app.callback());
      const res = await agent.post('/api/access').send({ code: ACCESS_CODE });
      if (res.status !== 204) throw new Error(`access failed: ${res.status}`);
      return agent;
    },
  };
}

/** Parses Set-Cookie headers into name -> raw header. */
export function setCookies(res: request.Response): Map<string, string> {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return new Map((raw ?? []).map((c) => [c.split('=')[0] ?? '', c]));
}

/** The "name=value" pairs from Set-Cookie, ready for a Cookie request header. */
export function cookieHeader(res: request.Response): string {
  return [...setCookies(res).values()].map((c) => c.split(';')[0]).join('; ');
}
