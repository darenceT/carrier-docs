import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SessionEvent } from '@carrier-docs/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { formatSseEvent } from '../../src/api/sse.js';
import { KNOWN_SESSION } from './fake-session-service.js';
import { ACCESS_CODE, makeHarness, type Harness } from './helpers.js';

let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function listen(h: Harness): Promise<string> {
  const handle = h.app.callback();
  server = http.createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function accessCookie(base: string): Promise<string> {
  const res = await fetch(`${base}/api/access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: ACCESS_CODE }),
  });
  expect(res.status).toBe(204);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

/** Reads the stream until `predicate(text so far)` holds. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  while (!predicate(text)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended early: ${JSON.stringify(text)}`);
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const mfa: SessionEvent = {
  type: 'mfa_required',
  hint: 'Code sent by text to •••-•••-1234',
  attemptsLeft: 3,
  lastAttemptRejected: false,
};
const ready: SessionEvent = { type: 'document_ready', documentId: 'doc-1', elapsedMs: 4321 };

describe('GET /api/sessions/:id/events (SSE)', () => {
  it('sends status first, then pushed events in order, and unsubscribes on disconnect', async () => {
    const h = makeHarness({ heartbeatMs: 60_000 });
    const base = await listen(h);
    const cookie = await accessCookie(base);
    const controller = new AbortController();

    const res = await fetch(`${base}/api/sessions/${KNOWN_SESSION}/events`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('connection')).toBe('keep-alive');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const reader = res.body!.getReader();
    const first = await readUntil(reader, (t) => t.includes('\n\n'));
    expect(first).toBe(
      'event: status\ndata: {"type":"status","status":"logging_in","timings":[],"elapsedMs":5}\n\n',
    );

    h.sessions.push(KNOWN_SESSION, mfa);
    h.sessions.push(KNOWN_SESSION, ready);
    h.sessions.push(KNOWN_SESSION, { type: 'done' });
    const rest = await readUntil(reader, (t) => t.includes('event: done'));
    expect(rest).toBe(
      formatSseEvent(mfa) + formatSseEvent(ready) + formatSseEvent({ type: 'done' }),
    );
    expect(rest).toContain(`event: mfa_required\ndata: ${JSON.stringify(mfa)}\n\n`);

    expect(h.sessions.subscriberCount(KNOWN_SESSION)).toBe(1);
    controller.abort();
    await waitFor(() => h.sessions.calls.some((c) => c.method === 'unsubscribe'));
    expect(h.sessions.subscriberCount(KNOWN_SESSION)).toBe(0);
  });

  it('sends heartbeat comments every heartbeatMs', async () => {
    const h = makeHarness({ heartbeatMs: 20 });
    const base = await listen(h);
    const cookie = await accessCookie(base);
    const controller = new AbortController();
    const res = await fetch(`${base}/api/sessions/${KNOWN_SESSION}/events`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const text = await readUntil(reader, (t) => t.split(': ping\n\n').length > 2);
    expect(text.startsWith('event: status\n')).toBe(true);
    controller.abort();
    await waitFor(() => h.sessions.calls.some((c) => c.method === 'unsubscribe'));
  });

  it('answers 404 ErrorBody for an unknown session, before streaming', async () => {
    const h = makeHarness();
    const base = await listen(h);
    const cookie = await accessCookie(base);
    const res = await fetch(`${base}/api/sessions/nope/events`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false },
    });
  });

  it('requires the access cookie', async () => {
    const h = makeHarness();
    const base = await listen(h);
    const res = await fetch(`${base}/api/sessions/${KNOWN_SESSION}/events`);
    expect(res.status).toBe(401);
    expect(h.sessions.calls).toEqual([]);
  });

  it('writes only contract fields, so extra properties never reach the wire', () => {
    const leaky = { ...ready, password: 'hunter2', storageState: { cookies: [] } } as SessionEvent;
    const out = formatSseEvent(leaky);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('storageState');
    expect(out).toBe(formatSseEvent(ready));
  });
});
