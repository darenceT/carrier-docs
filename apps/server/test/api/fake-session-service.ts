import type { CarrierInfo, SessionEvent, StartSessionRequest } from '@carrier-docs/contracts';
import { AppError } from '../../src/core/errors.js';
import type { DocumentContent, SessionService } from '../../src/core/ports.js';

export type Call =
  | { method: 'listCarriers' }
  | { method: 'prewarm'; ownerId: string; carrierId: string }
  | { method: 'start'; ownerId: string; input: StartSessionRequest }
  | { method: 'submitMfa'; ownerId: string; sessionId: string; code: string }
  | { method: 'subscribe'; ownerId: string; sessionId: string }
  | { method: 'unsubscribe'; ownerId: string; sessionId: string }
  | { method: 'getDocument'; ownerId: string; sessionId: string; documentId: string }
  | { method: 'forget'; ownerId: string };

type Method = Exclude<Call['method'], 'unsubscribe'>;

export const CARRIERS: CarrierInfo[] = [
  {
    id: 'demo',
    name: 'Demo carrier (test fixture)',
    isDemo: true,
    loginFields: ['username', 'password'],
  },
  { id: 'progressive', name: 'Progressive', isDemo: false, loginFields: ['username', 'password'] },
  { id: 'lemonade', name: 'Lemonade', isDemo: false, loginFields: ['email'] },
];

export const KNOWN_SESSION = 'sess-1';

/**
 * A SessionService for API tests: records every call, can be told to throw from any method, and
 * lets tests push SessionEvents to subscribers. Only KNOWN_SESSION exists.
 */
export class FakeSessionService implements SessionService {
  readonly calls: Call[] = [];
  readonly failures = new Map<Method, unknown>();
  readonly listeners = new Map<string, Set<(event: SessionEvent) => void>>();
  initialStatus: SessionEvent = { type: 'status', status: 'logging_in', timings: [], elapsedMs: 5 };
  document: DocumentContent = {
    mimeType: 'application/pdf',
    filename: 'id-card.pdf',
    body: new TextEncoder().encode('%PDF-1.4 fake'),
  };
  forgetCount = 2;

  /** Make `method` throw `error` from now on. */
  failWith(method: Method, error: unknown): void {
    this.failures.set(method, error);
  }

  private maybeFail(method: Method): void {
    const err = this.failures.get(method);
    if (err !== undefined) throw err;
  }

  private requireSession(sessionId: string): void {
    if (sessionId !== KNOWN_SESSION) throw new AppError('NOT_FOUND');
  }

  /** Deliver an event to every subscriber of `sessionId`. */
  push(sessionId: string, event: SessionEvent): void {
    for (const l of this.listeners.get(sessionId) ?? []) l(event);
  }

  subscriberCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0;
  }

  listCarriers(): CarrierInfo[] {
    this.calls.push({ method: 'listCarriers' });
    this.maybeFail('listCarriers');
    return CARRIERS;
  }

  async prewarm(ownerId: string, carrierId: string): Promise<{ sessionId: string }> {
    this.calls.push({ method: 'prewarm', ownerId, carrierId });
    this.maybeFail('prewarm');
    return { sessionId: 'prewarm-1' };
  }

  async start(ownerId: string, input: StartSessionRequest): Promise<{ sessionId: string }> {
    this.calls.push({ method: 'start', ownerId, input });
    this.maybeFail('start');
    return { sessionId: KNOWN_SESSION };
  }

  async submitMfa(ownerId: string, sessionId: string, code: string): Promise<void> {
    this.calls.push({ method: 'submitMfa', ownerId, sessionId, code });
    this.maybeFail('submitMfa');
    this.requireSession(sessionId);
  }

  subscribe(
    ownerId: string,
    sessionId: string,
    listener: (event: SessionEvent) => void,
  ): () => void {
    this.calls.push({ method: 'subscribe', ownerId, sessionId });
    this.maybeFail('subscribe');
    this.requireSession(sessionId);
    const set = this.listeners.get(sessionId) ?? new Set();
    this.listeners.set(sessionId, set);
    set.add(listener);
    listener(this.initialStatus);
    return () => {
      this.calls.push({ method: 'unsubscribe', ownerId, sessionId });
      set.delete(listener);
    };
  }

  async getDocument(
    ownerId: string,
    sessionId: string,
    documentId: string,
  ): Promise<DocumentContent> {
    this.calls.push({ method: 'getDocument', ownerId, sessionId, documentId });
    this.maybeFail('getDocument');
    this.requireSession(sessionId);
    if (documentId !== 'doc-1') throw new AppError('NOT_FOUND');
    return this.document;
  }

  async forget(ownerId: string): Promise<number> {
    this.calls.push({ method: 'forget', ownerId });
    this.maybeFail('forget');
    return this.forgetCount;
  }
}
