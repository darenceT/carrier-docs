import type {
  EventsTransport,
  SessionEvent,
  SessionEventType,
  SessionSnapshot,
} from '@carrier-docs/contracts';

/** The part of EventSource we use, so a fake can stand in for it in dev. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export const browserEventSource: EventSourceFactory = (url) =>
  new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;

const EVENT_TYPES: readonly SessionEventType[] = [
  'status',
  'mfa_required',
  'documents_listed',
  'document_ready',
  'failed',
  'done',
];

/** EventSource.CLOSED; a literal so this module also loads where EventSource is undefined. */
const CLOSED = 2;

/**
 * Opens the session event stream with one listener per named SSE event. Closes itself after
 * `done` or `failed`. Returns a function that closes it (for start over and unmount).
 */
export function openSessionEvents(
  factory: EventSourceFactory,
  url: string,
  onEvent: (event: SessionEvent) => void,
  onLost: () => void,
): () => void {
  const source = factory(url);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };

  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (ev) => {
      if (closed) return;
      let data: unknown;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      // The SSE event name is authoritative for the type.
      const event = { ...(data as object), type } as SessionEvent;
      if (type === 'done' || type === 'failed') close();
      onEvent(event);
    });
  }

  // The browser retries transient drops by itself (and the server re-sends `status` on
  // reconnect). Only a stream the browser gave up on counts as lost.
  source.addEventListener('error', () => {
    if (closed) return;
    if (source.readyState === CLOSED) {
      close();
      onLost();
    }
  });

  return close;
}

/**
 * What makes an event new to the UI. A status repeats with a fresh elapsedMs on every poll, so it
 * counts as new only when the step or its timings change.
 */
function eventKey(event: SessionEvent): string {
  if (event.type === 'status') return `status:${event.status}:${event.timings.length}`;
  return canonical(event);
}

/** JSON with object keys sorted: an SSE event is built as {...data, type}, a snapshot's isn't. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Remembers the last event of each type delivered, so a replayed one is dropped. */
export class EventDeduper {
  private readonly last = new Map<SessionEventType, string>();

  /** True if the event is new; records it either way. */
  accept(event: SessionEvent): boolean {
    const key = eventKey(event);
    if (this.last.get(event.type) === key) return false;
    this.last.set(event.type, key);
    return true;
  }
}

export interface PollingOptions {
  intervalMs?: number;
  /** Consecutive failed polls (network or 5xx) before giving up: 40 x 250 ms is about 10 s. */
  maxFailures?: number;
  deduper?: EventDeduper;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Status codes that will not get better by asking again. */
const FATAL_STATUSES = new Set([401, 403, 404]);

/**
 * Follows a session by polling its snapshot (the fallback when SSE is buffered or keeps dropping).
 * Delivers only events it has not delivered before, stops after `done` or `failed`, and calls
 * `onLost` once if the server stops answering. Returns a function that stops it.
 */
export function openSessionPolling(
  fetchSnapshot: () => Promise<SessionSnapshot>,
  onEvent: (event: SessionEvent) => void,
  onLost: () => void,
  {
    intervalMs = 250,
    maxFailures = 40,
    deduper = new EventDeduper(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }: PollingOptions = {},
): () => void {
  let stopped = false;
  let failures = 0;
  let timer: unknown;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
  };
  const lose = () => {
    stop();
    onLost();
  };

  const poll = async () => {
    timer = undefined;
    let snapshot: SessionSnapshot;
    try {
      snapshot = await fetchSnapshot();
    } catch (err) {
      if (stopped) return;
      const status = (err as { status?: unknown }).status;
      if (typeof status === 'number' && FATAL_STATUSES.has(status)) return lose();
      if (++failures >= maxFailures) return lose();
      timer = setTimer(() => void poll(), intervalMs);
      return;
    }
    if (stopped) return;
    failures = 0;
    for (const event of snapshot.events) {
      if (!deduper.accept(event)) continue;
      if (event.type === 'done' || event.type === 'failed') stop();
      onEvent(event);
      if (stopped) return;
    }
    timer = setTimer(() => void poll(), intervalMs);
  };

  void poll();
  return stop;
}

export interface FollowOptions {
  transport: EventsTransport;
  eventSource: EventSourceFactory;
  eventsUrl: string;
  fetchSnapshot: () => Promise<SessionSnapshot>;
  polling?: Omit<PollingOptions, 'deduper'>;
}

/**
 * Follows a session over SSE, or by polling when `transport` is 'poll'. If the SSE stream is lost
 * (the browser gave up reconnecting), it switches to polling before reporting the session lost,
 * without replaying events the stream already delivered.
 */
export function followSession(
  { transport, eventSource, eventsUrl, fetchSnapshot, polling }: FollowOptions,
  onEvent: (event: SessionEvent) => void,
  onLost: () => void,
): () => void {
  const deduper = new EventDeduper();
  const poll = () => openSessionPolling(fetchSnapshot, onEvent, onLost, { ...polling, deduper });
  if (transport === 'poll') return poll();

  let stop = openSessionEvents(
    eventSource,
    eventsUrl,
    (event) => {
      deduper.accept(event);
      onEvent(event);
    },
    () => {
      stop = poll();
    },
  );
  return () => stop();
}
