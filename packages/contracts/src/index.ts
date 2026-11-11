/**
 * The contract between the web app and the server: HTTP routes, request and response bodies,
 * and the Server-Sent Events stream. TYPES ONLY: import with `import type`, so nothing from
 * this package exists at runtime and no build step is needed.
 *
 * Routes (all JSON unless noted; every /api route except POST /api/access needs the access cookie):
 *
 *   POST   /api/access                                AccessRequest -> 204, sets signed cookie
 *   GET    /api/carriers                              -> CarriersResponse
 *   POST   /api/sessions/prewarm                      PrewarmRequest -> 202 SessionCreated
 *   POST   /api/sessions                              StartSessionRequest -> 202 SessionCreated
 *   GET    /api/sessions/:sessionId/events            -> text/event-stream of SessionEvent
 *   POST   /api/sessions/:sessionId/mfa               MfaRequest -> 202
 *   GET    /api/sessions/:sessionId/documents/:docId  -> the document bytes (application/pdf)
 *   DELETE /api/me                                    -> ForgetResponse ("Forget me")
 *   GET    /healthz                                   -> { ok: true }
 *
 * Errors: any non-2xx JSON response has the body ErrorBody.
 */

// ---------- shared ----------

/** Mirrors ERROR_CODES in apps/server/src/core/errors.ts. */
export type ErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'MFA_REQUIRED'
  | 'MFA_INVALID'
  | 'MFA_TIMEOUT'
  | 'BLOCKED'
  | 'CARRIER_UNAVAILABLE'
  | 'SESSION_EXPIRED'
  | 'BUSY'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'VALIDATION_FAILED'
  | 'INTERNAL';

export interface ErrorBody {
  error: { code: ErrorCode; message: string; retryable: boolean };
}

/** Mirrors STATUSES in apps/server/src/core/state-machine.ts. */
export type SessionStatus =
  | 'idle'
  | 'prewarming'
  | 'logging_in'
  | 'mfa_required'
  | 'verifying_mfa'
  | 'fetching_docs'
  | 'document_ready'
  | 'done'
  | 'failed';

// ---------- requests and responses ----------

export interface AccessRequest {
  code: string;
}

export interface CarrierInfo {
  /** Stable ID used in requests, e.g. "progressive", "demo". */
  id: string;
  /** Display name, e.g. "Progressive", "Demo carrier (test fixture)". */
  name: string;
  /** True for the Demo carrier: a test fixture, not a real portal. */
  isDemo: boolean;
}

export interface CarriersResponse {
  carriers: CarrierInfo[];
}

/** Sent when the user picks a carrier, so the login page starts loading while they type. */
export interface PrewarmRequest {
  carrierId: string;
}

export interface StartSessionRequest {
  carrierId: string;
  username: string;
  password: string;
  /** The sessionId returned by prewarm, if one was made. Optional. */
  prewarmSessionId?: string;
}

export interface SessionCreated {
  sessionId: string;
}

export interface MfaRequest {
  code: string;
}

export interface ForgetResponse {
  /** How many saved sessions were deleted. */
  deleted: number;
}

// ---------- documents ----------

export type DocumentKind = 'id_card' | 'declarations' | 'policy' | 'other';

export interface DocumentMeta {
  /** Opaque, unique within the session. */
  id: string;
  title: string;
  kind: DocumentKind;
  /** Last 4 characters only, e.g. "••••1234"; never the full number. */
  policyNumberMasked?: string;
  mimeType: string;
}

// ---------- Server-Sent Events: GET /api/sessions/:id/events ----------

/** Time spent in one step, for the on-screen timing panel and the README latency table. */
export interface StepTiming {
  step: string;
  ms: number;
}

/**
 * Each SSE message has `event: <type>` and `data: <JSON of the event>`.
 * On connect the server immediately sends one `status` event with the current state, so a
 * reconnecting browser catches up. A heartbeat comment (`: ping`) arrives every 15 s.
 */
export type SessionEvent =
  | {
      type: 'status';
      status: SessionStatus;
      /** Every step completed so far, in order. */
      timings: StepTiming[];
      /** Milliseconds since the session started. */
      elapsedMs: number;
    }
  | {
      type: 'mfa_required';
      /** e.g. "Code sent by text to •••-•••-1234", if the carrier says so. */
      hint?: string;
      attemptsLeft: number;
      /** Set when a previous code was rejected. */
      lastAttemptRejected: boolean;
    }
  | { type: 'documents_listed'; documents: DocumentMeta[] }
  | {
      /** The first document (an ID card when there is one) is cached and can be fetched now. */
      type: 'document_ready';
      documentId: string;
      /** Milliseconds from session start to this moment: the headline latency number. */
      elapsedMs: number;
    }
  | { type: 'failed'; code: ErrorCode; message: string; retryable: boolean }
  | { type: 'done' };

export type SessionEventType = SessionEvent['type'];
