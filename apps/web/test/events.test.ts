import type { SessionEvent } from '@carrier-docs/contracts';
import { describe, expect, it } from 'vitest';
import { openSessionEvents, type EventSourceLike } from '../src/events.ts';

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

function open() {
  let source!: FakeSource;
  const events: SessionEvent[] = [];
  let lost = 0;
  const close = openSessionEvents(
    () => (source = new FakeSource()),
    '/api/sessions/s1/events',
    (e) => events.push(e),
    () => lost++,
  );
  return { source, events, close, lost: () => lost };
}

describe('openSessionEvents', () => {
  it('listens to every named event and closes after done', () => {
    const { source, events } = open();
    expect([...source.listeners.keys()].sort()).toEqual(
      [
        'document_ready',
        'documents_listed',
        'done',
        'error',
        'failed',
        'mfa_required',
        'status',
      ].sort(),
    );
    source.fire('status', { status: 'logging_in', timings: [], elapsedMs: 5 });
    source.fire('done', {});
    expect(events).toEqual([
      { type: 'status', status: 'logging_in', timings: [], elapsedMs: 5 },
      { type: 'done' },
    ]);
    expect(source.closed).toBe(true);
    source.fire('status', { status: 'done', timings: [], elapsedMs: 9 });
    expect(events).toHaveLength(2);
  });

  it('closes after failed', () => {
    const { source, events } = open();
    source.fire('failed', { code: 'BLOCKED', message: 'm', retryable: false });
    expect(events[0]).toMatchObject({ type: 'failed', code: 'BLOCKED' });
    expect(source.closed).toBe(true);
  });

  it('reports a lost stream only when the browser gave up', () => {
    const { source, lost } = open();
    source.readyState = 0; // reconnecting
    source.fire('error');
    expect(lost()).toBe(0);
    source.readyState = 2;
    source.fire('error');
    expect(lost()).toBe(1);
  });

  it('close() stops delivery', () => {
    const { source, events, close } = open();
    close();
    expect(source.closed).toBe(true);
    source.fire('done', {});
    expect(events).toHaveLength(0);
  });
});
