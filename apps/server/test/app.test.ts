import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('health checks', () => {
  it('GET /healthz returns ok', async () => {
    const res = await request(createApp().callback()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('the temporary disk check is gone', async () => {
    const res = await request(createApp().callback()).get('/healthz/disk');
    expect(res.status).toBe(404);
  });

  it('unknown routes return 404', async () => {
    const res = await request(createApp().callback()).get('/nope');
    expect(res.status).toBe(404);
  });
});
