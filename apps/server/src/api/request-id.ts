import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** An upstream ID (Render's proxy, a client) is kept only if it looks like one. */
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;
const SESSION_PATH = /^\/api\/sessions\/([0-9a-f-]{36})(?:\/|$)/i;

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Request ID for every API log line, echoed in X-Request-Id so a user report can be traced. */
export function genReqId(req: IncomingMessage, res: ServerResponse): string {
  const upstream = req.headers['x-request-id'];
  const id = typeof upstream === 'string' && SAFE_ID.test(upstream) ? upstream : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/** Adds the session ID, when the path names one, to the request's log lines. */
export function sessionIdProps(req: IncomingMessage): { sessionId?: string } {
  const match = SESSION_PATH.exec(req.url ?? '');
  return match ? { sessionId: match[1]!.toLowerCase() } : {};
}
