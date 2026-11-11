import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/infra/logger.js';
import { FakeSessionService } from './api/fake-session-service.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'carrier-docs-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('health checks', () => {
  it('GET /healthz returns ok', async () => {
    const res = await request(createApp({ dataDir }).callback()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /healthz/disk writes and reads a file in DATA_DIR', async () => {
    const res = await request(createApp({ dataDir }).callback()).get('/healthz/disk');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /healthz/disk reports 500 when DATA_DIR is unusable', async () => {
    const blocker = path.join(dataDir, 'not-a-dir');
    await writeFile(blocker, 'x');
    const res = await request(createApp({ dataDir: blocker }).callback()).get('/healthz/disk');
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it('unknown routes return 404', async () => {
    const res = await request(createApp({ dataDir }).callback()).get('/nope');
    expect(res.status).toBe(404);
  });
});

describe('with the API mounted', () => {
  const api = {
    sessions: new FakeSessionService(),
    accessCode: 'open-sesame-123',
    logger: createLogger({ level: 'silent' }),
    secureCookies: false,
    cookieKeys: ['k1'],
  };

  it('keeps health checks working and adds security headers', async () => {
    const res = await request(createApp({ dataDir, api }).callback()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('keeps /healthz/disk working', async () => {
    const res = await request(createApp({ dataDir, api }).callback()).get('/healthz/disk');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('serves static files without the access cookie', async () => {
    const webDistDir = path.join(dataDir, 'web');
    await mkdir(webDistDir);
    await writeFile(path.join(webDistDir, 'index.html'), '<!doctype html><p>hi</p>');
    const res = await request(createApp({ dataDir, webDistDir, api }).callback()).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<p>hi</p>');
  });

  it('gates /api routes', async () => {
    const res = await request(createApp({ dataDir, api }).callback()).get('/api/carriers');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('trusts the proxy and signs cookies with the given keys', () => {
    const app = createApp({ dataDir, api });
    expect(app.proxy).toBe(true);
    expect(app.keys).toEqual(['k1']);
  });

  it('refuses an empty cookie key list', () => {
    expect(() => createApp({ dataDir, api: { ...api, cookieKeys: [] } })).toThrow(/cookieKeys/);
  });
});
