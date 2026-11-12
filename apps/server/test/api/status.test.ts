import type { StatusResponse } from '@carrier-docs/contracts';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ACCESS_CODE, makeHarness } from './helpers.js';

const STATUS: StatusResponse = {
  since: '2026-11-11T00:00:00.000Z',
  sessions: { live: 1, slotsInUse: 1, waiting: 0 },
  carriers: {
    demo: {
      attempts: 2,
      outcomes: { done: 1, CARRIER_BLOCKED: 1 },
      blockRate: 0.5,
      timeToFirstDocument: {
        all: { count: 1, p50: 900, p95: 900 },
        fullLogin: { count: 1, p50: 900, p95: 900 },
        fastPath: { count: 0 },
        prewarmed: { count: 0 },
        notPrewarmed: { count: 1, p50: 900, p95: 900 },
      },
    },
  },
};

describe('GET /api/status', () => {
  it('needs the access cookie', async () => {
    const { app } = makeHarness({ status: () => STATUS });
    expect((await request(app.callback()).get('/api/status')).status).toBe(401);
  });

  it('returns the status, never cached', async () => {
    const agent = await makeHarness({ status: () => STATUS }).authed();
    const res = await agent.get('/api/status');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual(STATUS);
  });

  it('is absent unless a status source is given', async () => {
    const agent = await makeHarness().authed();
    expect((await agent.get('/api/status')).status).toBe(404);
  });
});

describe('request and session IDs in logs', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('gives every API response an X-Request-Id and logs it', async () => {
    const { app, logs } = makeHarness();
    const res = await request(app.callback()).get('/api/carriers');
    const id = res.headers['x-request-id'] as string;
    expect(id).toMatch(UUID);
    expect(logs()).toContain(id);
  });

  it('keeps a well-formed upstream request ID and replaces anything else', async () => {
    const { app } = makeHarness();
    const kept = await request(app.callback())
      .get('/api/carriers')
      .set('X-Request-Id', 'rndr-abc12345');
    expect(kept.headers['x-request-id']).toBe('rndr-abc12345');
    const replaced = await request(app.callback())
      .get('/api/carriers')
      .set('X-Request-Id', 'bad id with "quotes"');
    expect(replaced.headers['x-request-id']).toMatch(UUID);
  });

  it('adds the session ID to the log lines of session routes, never the code', async () => {
    const sessionId = '0f0e0d0c-0b0a-4908-8706-050403020100';
    const { app, logs } = makeHarness();
    const agent = request.agent(app.callback());
    await agent.post('/api/access').send({ code: ACCESS_CODE });
    await agent.post(`/api/sessions/${sessionId}/mfa`).send({ code: '987654' });
    const lines = logs()
      .split('\n')
      .filter((l) => l.includes(`/api/sessions/${sessionId}/mfa`));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(JSON.parse(line).sessionId).toBe(sessionId);
    expect(logs()).not.toContain('987654');
  });
});
