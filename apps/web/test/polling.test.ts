import type { SessionEvent, SessionSnapshot } from '@carrier-docs/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import {
  followSession,
  openSessionPolling,
  type EventSourceLike,
  type PollingOptions,
} from '../src/events.ts';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Timers the test runs by hand: `tick()` fires the pending poll and waits for it. */
function manualTimers() {
  let pending: (() => void) | undefined;
  const options: Pick<PollingOptions, 'setTimer' | 'clearTimer'> = {
    setTimer: (fn) => {
      pending = fn;
      return fn;
    },
    clearTimer: () => {
      pending = undefined;
    },
  };
  return {
    options,
    scheduled: () => pending !== undefined,
    tick: async () => {
      const fn = pending;
      pending = undefined;
      fn?.();
      await flush();
    },
  };
}

const status = (s: string, steps = 0, elapsedMs = 1): SessionEvent =>
  ({
    type: 'status',
    status: s,
    timings: Array.from({ length: steps }, (_, i) => ({ step: `s${i}`, ms: 1 })),
    elapsedMs,
  }) as SessionEvent;

function poller(responses: (SessionSnapshot | Error)[], extra: PollingOptions = {}) {
  const timers = manualTimers();
  const events: SessionEvent[] = [];
  let lost = 0;
  let calls = 0;
  const fetchSnapshot = () => {
    const next = responses[Math.min(calls++, responses.length - 1)]!;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const stop = openSessionPolling(
    fetchSnapshot,
    (e) => events.push(e),
    () => lost++,
    { ...timers.options, ...extra },
  );
  return { ...timers, events, stop, lost: () => lost, calls: () => calls };
}

describe('openSessionPolling', () => {
  it('delivers each event once, ignoring a status whose only change is elapsedMs', async () => {
    const mfa: SessionEvent = { type: 'mfa_required', attemptsLeft: 3 } as SessionEvent;
    const p = poller([
      { events: [status('logging_in', 0, 10)] },
      { events: [status('logging_in', 0, 260)] },
      { events: [status('awaiting_mfa', 1, 500), mfa] },
      { events: [status('awaiting_mfa', 1, 760), mfa] },
    ]);
    await flush();
    for (let i = 0; i < 3; i++) await p.tick();
    expect(p.events).toEqual([status('logging_in', 0, 10), status('awaiting_mfa', 1, 500), mfa]);
    expect(p.scheduled()).toBe(true);
  });

  it('delivers a repeated MFA prompt once its contents change (a rejected code)', async () => {
    const first = { type: 'mfa_required', attemptsLeft: 3 } as SessionEvent;
    const retry = {
      type: 'mfa_required',
      attemptsLeft: 2,
      lastAttemptRejected: true,
    } as SessionEvent;
    const p = poller([{ events: [first] }, { events: [first] }, { events: [retry] }]);
    await flush();
    await p.tick();
    await p.tick();
    expect(p.events).toEqual([first, retry]);
  });

  it('stops after done', async () => {
    const p = poller([{ events: [status('fetching', 2), { type: 'done' } as SessionEvent] }]);
    await flush();
    expect(p.events.map((e) => e.type)).toEqual(['status', 'done']);
    expect(p.scheduled()).toBe(false);
    expect(p.lost()).toBe(0);
  });

  it('stops after failed', async () => {
    const failed = { type: 'failed', code: 'BAD_CREDENTIALS', message: 'm', retryable: false };
    const p = poller([{ events: [failed as SessionEvent] }]);
    await flush();
    expect(p.events).toEqual([failed]);
    expect(p.scheduled()).toBe(false);
  });

  it('rides out transient failures, then gives up after maxFailures in a row', async () => {
    const down = new ApiError('INTERNAL', 'x', true, 0);
    const p = poller([{ events: [status('logging_in')] }, down, down, down], { maxFailures: 3 });
    await flush();
    await p.tick();
    await p.tick();
    expect(p.lost()).toBe(0);
    await p.tick();
    expect(p.lost()).toBe(1);
    expect(p.scheduled()).toBe(false);
  });

  it('counts only consecutive failures', async () => {
    const down = new ApiError('INTERNAL', 'x', true, 503);
    const ok = { events: [status('logging_in')] };
    const p = poller([down, ok, down, ok, down], { maxFailures: 2 });
    await flush();
    for (let i = 0; i < 4; i++) await p.tick();
    expect(p.lost()).toBe(0);
    expect(p.calls()).toBe(5);
  });

  it.each([401, 404])('gives up at once on HTTP %i', async (code) => {
    const p = poller([new ApiError('NOT_FOUND', 'x', false, code)]);
    await flush();
    expect(p.lost()).toBe(1);
    expect(p.scheduled()).toBe(false);
  });

  it('stop() ends polling and drops a response still in flight', async () => {
    let resolve!: (s: SessionSnapshot) => void;
    const events: SessionEvent[] = [];
    const timers = manualTimers();
    const stop = openSessionPolling(
      () => new Promise((r) => (resolve = r)),
      (e) => events.push(e),
      () => {},
      timers.options,
    );
    stop();
    resolve({ events: [status('logging_in')] });
    await flush();
    expect(events).toEqual([]);
    expect(timers.scheduled()).toBe(false);
  });
});

class FakeSource implements EventSourceLike {
  readyState = 1;
  closed = false;
  listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  fire(type: string, data?: unknown) {
    const ev = { data: data === undefined ? '' : JSON.stringify(data) } as MessageEvent<string>;
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

describe('followSession', () => {
  function follow(transport: 'sse' | 'poll', snapshots: SessionSnapshot[]) {
    const timers = manualTimers();
    let source: FakeSource | undefined;
    const events: SessionEvent[] = [];
    let lost = 0;
    let polls = 0;
    const stop = followSession(
      {
        transport,
        eventSource: () => (source = new FakeSource()),
        eventsUrl: '/api/sessions/s1/events',
        fetchSnapshot: () => Promise.resolve(snapshots[Math.min(polls++, snapshots.length - 1)]!),
        polling: timers.options,
      },
      (e) => events.push(e),
      () => lost++,
    );
    return { ...timers, source: () => source, events, stop, lost: () => lost, polls: () => polls };
  }

  it("polls only, with no event stream, when the transport is 'poll'", async () => {
    const f = follow('poll', [{ events: [status('logging_in')] }]);
    await flush();
    expect(f.source()).toBeUndefined();
    expect(f.events).toEqual([status('logging_in')]);
  });

  it('uses SSE, and falls back to polling without replays when the stream is lost', async () => {
    const mfa = { type: 'mfa_required', attemptsLeft: 3 } as SessionEvent;
    const f = follow('sse', [
      { events: [status('awaiting_mfa', 1, 900), mfa] },
      { events: [status('fetching', 2), { type: 'done' } as SessionEvent] },
    ]);
    const source = f.source()!;
    source.fire('status', {
      status: 'awaiting_mfa',
      timings: [{ step: 's0', ms: 1 }],
      elapsedMs: 5,
    });
    source.fire('mfa_required', { attemptsLeft: 3 });
    expect(f.polls()).toBe(0);

    source.readyState = 2;
    source.fire('error');
    await flush();
    expect(f.polls()).toBe(1);
    expect(f.lost()).toBe(0);
    // The first snapshot repeated what the stream had sent: nothing new delivered.
    expect(f.events.map((e) => e.type)).toEqual(['status', 'mfa_required']);

    await f.tick();
    expect(f.events.map((e) => e.type)).toEqual(['status', 'mfa_required', 'status', 'done']);
    expect(f.lost()).toBe(0);
  });

  it('stop() closes whichever is running', async () => {
    const f = follow('sse', [{ events: [status('logging_in')] }]);
    const source = f.source()!;
    source.readyState = 2;
    source.fire('error');
    await flush();
    expect(f.scheduled()).toBe(true);
    f.stop();
    expect(f.scheduled()).toBe(false);
  });
});
