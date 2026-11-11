import type { CarrierInfo, SessionEvent, StartSessionRequest } from '@carrier-docs/contracts';

/**
 * Ports: the interfaces the core depends on. Implementations live outside core/
 * (infra/, store/, antibot/, carriers/) and are injected, so tests can pass fakes.
 */

/** Injectable time source, so timeouts and TTLs are testable in milliseconds. */
export interface Clock {
  now(): number;
}

/** One coherent device identity, kept per user and carrier so a returning user looks the same. */
export interface FingerprintProfile {
  userAgent: string;
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
}

/** What is saved between runs so a repeat run can skip login and MFA. Never a password. */
export interface SavedSession {
  carrierId: string;
  /** Browser storage state (cookies, local storage) as produced by the automation library. */
  storageState: unknown;
  fingerprint: FingerprintProfile;
  savedAt: number;
}

/**
 * Persistence for saved sessions. Keys are opaque reuse keys derived from the browser-cookie ID,
 * carrier and a keyed hash of the username. `ownerId` is the browser-cookie ID, used by "Forget me".
 */
export interface SessionStore {
  get(key: string): Promise<SavedSession | undefined>;
  put(key: string, ownerId: string, session: SavedSession, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** "Forget me": remove every saved session belonging to one browser. Returns how many. */
  deleteByOwner(ownerId: string): Promise<number>;
  /** Remove expired rows. Returns how many. */
  purgeExpired(): Promise<number>;
  close(): Promise<void>;
}

// ---------- the session service the API depends on ----------

/** A fetched document, ready to stream to the browser. Never logged. */
export interface DocumentContent {
  mimeType: string;
  filename: string;
  body: Uint8Array | AsyncIterable<Uint8Array>;
}

/**
 * Everything the HTTP API needs from the session layer. The SessionManager implements it; API
 * tests use a fake. `ownerId` is the browser-cookie ID: a caller can only see its own sessions,
 * and every method throws AppError('NOT_FOUND') for a session it doesn't own.
 */
export interface SessionService {
  listCarriers(): CarrierInfo[];
  /**
   * Start loading the carrier's login page while the user types. Best effort: the UI ignores
   * failures, and a login works without a pre-warm, only slower.
   *
   * - Holds a browser slot. One unused pre-warm per owner: a new one closes the previous.
   * - Closes after 2 minutes unused, quietly (no `failed` event; nobody is listening).
   * - Throws AppError('BUSY') at the cap, ('VALIDATION_FAILED') for an unknown carrier.
   */
  prewarm(ownerId: string, carrierId: string): Promise<{ sessionId: string }>;
  /**
   * Start a login. `input.prewarmSessionId` is a hint, never a reason to fail:
   *
   * - It is adopted only if it belongs to `ownerId`, is for the same carrier, is still unused,
   *   and no saved session exists for the reuse key. A returning user needs a context built
   *   from the saved device profile instead, so the pre-warm is closed first, and the session
   *   never holds two slots.
   * - Unknown, expired, used or another owner's IDs are ignored: a fresh login runs. (Treat
   *   another owner's ID exactly like an unknown one, so IDs can't be probed.)
   * - If the pre-warm is still loading, wait for it (bounded by the login timeout). If it
   *   failed, close it and log in fresh.
   * - Every call returns a new sessionId, used for events, MFA and documents.
   *
   * Capacity: at the cap, close this owner's own unused pre-warm, then the oldest unused
   * pre-warm of anyone. A real login outranks a pre-warm. If every slot is still held by a
   * login, the session waits in line (`queued`, holding no slot) for up to QUEUE_WAIT_S, first
   * in first out, then fails with BUSY on its event stream. The cap check and the slot
   * reservation happen together, with no await in between.
   *
   * Throws AppError('BUSY') only when the line itself is full (5 waiting),
   * ('VALIDATION_FAILED') for an unknown carrier or login fields that don't match it.
   */
  start(ownerId: string, input: StartSessionRequest): Promise<{ sessionId: string }>;
  submitMfa(ownerId: string, sessionId: string, code: string): Promise<void>;
  /** Calls `listener` at once with the current status, then with every later event. */
  subscribe(
    ownerId: string,
    sessionId: string,
    listener: (event: SessionEvent) => void,
  ): () => void;
  getDocument(ownerId: string, sessionId: string, documentId: string): Promise<DocumentContent>;
  /** "Forget me": close this browser's live sessions and delete its saved ones. */
  forget(ownerId: string): Promise<number>;
}
