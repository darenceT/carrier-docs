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
 *   GET    /api/sessions/:sessionId/snapshot          -> SessionSnapshot (polling fallback)
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
  | 'BAD_CREDENTIALS'
  | 'MFA_INVALID'
  | 'MFA_TIMEOUT'
  | 'CARRIER_BLOCKED'
  | 'CARRIER_CHALLENGE'
  | 'CARRIER_PAGE_CHANGED'
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
  | 'queued'
  | 'prewarming'
  | 'checking_session'
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
  /**
   * The fields this carrier's login form needs, in display order, e.g. ['username', 'password']
   * for Progressive and ['email'] for Lemonade. StartSessionRequest must carry exactly these.
   */
  loginFields: LoginField[];
}

export type LoginField = 'username' | 'password' | 'email';

/** How the UI should follow a session: the SSE stream, or polling the snapshot every 250 ms. */
export type EventsTransport = 'sse' | 'poll';

export interface CarriersResponse {
  carriers: CarrierInfo[];
  /** Set by the server (EVENTS_TRANSPORT); the UI uses SSE when it is absent. */
  eventsTransport?: EventsTransport;
}

/** Sent when the user picks a carrier, so the login page starts loading while they type. */
export interface PrewarmRequest {
  carrierId: string;
}

/** Exactly the carrier's `loginFields`, each non-empty; any other field is rejected. */
export interface StartSessionRequest {
  carrierId: string;
  username?: string;
  password?: string;
  email?: string;
  /**
   * The sessionId returned by prewarm, if one was made. A hint only: if it has expired or can't
   * be used, the server logs in without it rather than failing.
   */
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
      /** Milliseconds from session start to this moment, including any wait for the MFA code. */
      elapsedMs: number;
      /**
       * Milliseconds from the moment the accepted MFA code was submitted to this moment: the
       * headline latency number. Absent when no code was asked for (then elapsedMs is the
       * headline).
       */
      afterMfaMs?: number;
    }
  | { type: 'failed'; code: ErrorCode; message: string; retryable: boolean }
  | { type: 'done' };

export type SessionEventType = SessionEvent['type'];

// ---------- GET /api/status (behind the access code) ----------

/** Percentiles over the most recent samples, in milliseconds. */
export interface LatencySummary {
  count: number;
  p50?: number;
  p95?: number;
}

export interface CarrierStatus {
  /** Logins that reached an outcome (finished or failed) since the server started. */
  attempts: number;
  /** "done" or an ErrorCode -> count. */
  outcomes: Record<string, number>;
  /** (CARRIER_BLOCKED + CARRIER_CHALLENGE) / attempts, 0 when there are none. */
  blockRate: number;
  /**
   * Time to first document, excluding the time the user took to type the MFA code. `all` covers
   * every login; the rest split it by path and by whether a pre-warmed page was used.
   */
  timeToFirstDocument: {
    all: LatencySummary;
    fullLogin: LatencySummary;
    fastPath: LatencySummary;
    prewarmed: LatencySummary;
    notPrewarmed: LatencySummary;
  };
}

export interface StatusResponse {
  /** When the counters started (they are in memory and reset on restart or redeploy). */
  since: string;
  sessions: { live: number; slotsInUse: number; waiting: number };
  carriers: Record<string, CarrierStatus>;
}

/**
 * GET /api/sessions/:id/snapshot: the events a newly connected SSE stream would get first (the
 * current status, then whatever is still relevant: the open MFA prompt, the document list, the
 * ready document, done or failed). The polling fallback asks for it every 250 ms.
 */
export interface SessionSnapshot {
  events: SessionEvent[];
}
