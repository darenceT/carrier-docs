import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

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
