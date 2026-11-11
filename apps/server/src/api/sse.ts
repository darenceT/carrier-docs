import { PassThrough } from 'node:stream';
import type { SessionEvent } from '@carrier-docs/contracts';
import type { Context } from 'koa';
import type { SessionService } from '../core/ports.js';

/**
 * Copies only the contract's fields for each event type, so nothing else a producer might attach
 * (credentials, page content) can ever reach the wire.
 */
export function toWireEvent(event: SessionEvent): SessionEvent {
  switch (event.type) {
    case 'status':
      return {
        type: 'status',
        status: event.status,
        timings: event.timings.map(({ step, ms }) => ({ step, ms })),
        elapsedMs: event.elapsedMs,
      };
    case 'mfa_required':
      return {
        type: 'mfa_required',
        ...(event.hint !== undefined && { hint: event.hint }),
        attemptsLeft: event.attemptsLeft,
        lastAttemptRejected: event.lastAttemptRejected,
      };
    case 'documents_listed':
      return {
        type: 'documents_listed',
        documents: event.documents.map((d) => ({
          id: d.id,
          title: d.title,
          kind: d.kind,
          ...(d.policyNumberMasked !== undefined && { policyNumberMasked: d.policyNumberMasked }),
          mimeType: d.mimeType,
        })),
      };
    case 'document_ready':
      return { type: 'document_ready', documentId: event.documentId, elapsedMs: event.elapsedMs };
    case 'failed':
      return {
        type: 'failed',
        code: event.code,
        message: event.message,
        retryable: event.retryable,
      };
    case 'done':
      return { type: 'done' };
  }
}

export function formatSseEvent(event: SessionEvent): string {
  const wire = toWireEvent(event);
  return `event: ${wire.type}\ndata: ${JSON.stringify(wire)}\n\n`;
}

export const HEARTBEAT = ': ping\n\n';

/**
 * Streams a session's events. Subscribes before any header is sent, so a NOT_FOUND from the
 * service becomes a normal 404 ErrorBody. Cleans up the subscription and heartbeat on disconnect.
 */
export function streamSessionEvents(
  ctx: Context,
  sessions: SessionService,
  ownerId: string,
  sessionId: string,
  heartbeatMs: number,
): void {
  const stream = new PassThrough();
  let closed = false;

  // May throw (e.g. NOT_FOUND); the listener is called at once with the current status.
  const unsubscribe = sessions.subscribe(ownerId, sessionId, (event) => {
    if (!closed) stream.write(formatSseEvent(event));
  });

  const heartbeat = setInterval(() => {
    if (!closed) stream.write(HEARTBEAT);
  }, heartbeatMs);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    stream.end();
  };
  ctx.res.on('close', cleanup);
  stream.on('error', cleanup);

  ctx.req.socket.setTimeout(0);
  ctx.status = 200;
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  ctx.body = stream;
}
