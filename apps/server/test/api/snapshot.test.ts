import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { sessionSnapshot } from '../../src/api/sse.js';
import { FakeSessionService, KNOWN_SESSION } from './fake-session-service.js';
import { makeHarness } from './helpers.js';

describe('GET /api/sessions/:id/snapshot (polling fallback)', () => {
  it('returns the replayed events, uncached, and leaves no subscription behind', async () => {
    const { authed, sessions } = makeHarness();
    const res = await (await authed()).get(`/api/sessions/${KNOWN_SESSION}/snapshot`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      events: [{ type: 'status', status: 'logging_in', timings: [], elapsedMs: 5 }],
    });
    expect(sessions.subscriberCount(KNOWN_SESSION)).toBe(0);
    expect(sessions.calls.map((c) => c.method)).toEqual(['subscribe', 'unsubscribe']);
  });

  it('answers an unknown session with 404 NOT_FOUND', async () => {
    const { authed } = makeHarness();
    const res = await (await authed()).get('/api/sessions/nope/snapshot');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('needs the access cookie', async () => {
    const { app } = makeHarness();
    const res = await request(app.callback()).get(`/api/sessions/${KNOWN_SESSION}/snapshot`);
    expect(res.status).toBe(401);
  });

  it('sends only the wire fields of each event', () => {
    const sessions = new FakeSessionService();
    sessions.initialStatus = {
      type: 'status',
      status: 'logging_in',
      timings: [],
      elapsedMs: 5,
      internal: 'not for the browser',
    } as never;
    expect(sessionSnapshot(sessions, 'owner', KNOWN_SESSION)).toEqual([
      { type: 'status', status: 'logging_in', timings: [], elapsedMs: 5 },
    ]);
  });
});

describe('GET /api/carriers advertises the events transport', () => {
  it('omits it by default and includes it when configured', async () => {
    const plain = await (await makeHarness().authed()).get('/api/carriers');
    expect(plain.body).not.toHaveProperty('eventsTransport');
    const poll = await (
      await makeHarness({ eventsTransport: 'poll' }).authed()
    ).get('/api/carriers');
    expect(poll.body.eventsTransport).toBe('poll');
  });
});
