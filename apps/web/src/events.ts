import type { SessionEvent, SessionEventType } from '@carrier-docs/contracts';

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
