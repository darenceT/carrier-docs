import { AppError, type ErrorCode } from './errors.js';

/**
 * The login session state machine: a pure function, (state, event) -> new state.
 * No I/O, no timers. The SessionManager feeds it events and acts on the result.
 *
 *   idle -> queued (every slot busy; waits up to QUEUE_WAIT_S, then FAIL BUSY)
 *   idle | queued | prewarming -> checking_session --(saved session valid)--> fetching_docs
 *                                \--(missing or rejected)--> logging_in
 *   idle | queued | prewarming -> logging_in -> mfa_required <-> verifying_mfa --> fetching_docs
 *                                 \______________ (no MFA) _____________/
 *   fetching_docs -> document_ready -> done             any active state -> failed
 *
 * checking_session holds a browser context (it opens one to test the saved session), so it
 * counts toward MAX_SESSIONS like every other non-idle, non-terminal state.
 */
export const STATUSES = [
  'idle',
  'queued',
  'prewarming',
  'checking_session',
  'logging_in',
  'mfa_required',
  'verifying_mfa',
  'fetching_docs',
  'document_ready',
  'done',
  'failed',
] as const;

export type Status = (typeof STATUSES)[number];

export const MAX_MFA_ATTEMPTS = 3;

export interface SessionState {
  status: Status;
  mfaAttempts: number;
  /** Set only when status is 'failed'. */
  error?: { code: ErrorCode; retryable: boolean };
}

export type SessionEvent =
  | { type: 'PREWARM' }
  /** Every browser slot is busy: wait in line for one. Holds no slot while waiting. */
  | { type: 'QUEUE' }
  | { type: 'START_LOGIN' }
  /** A saved session exists for this reuse key: open it and test it before logging in. */
  | { type: 'CHECK_SAVED_SESSION' }
  /** The saved session was accepted by the carrier: skip login and MFA. */
  | { type: 'FAST_PATH_HIT' }
  /** The saved session was rejected or expired: fall back to a full login. */
  | { type: 'FAST_PATH_MISS' }
  | { type: 'LOGIN_OK' }
  | { type: 'MFA_REQUESTED' }
  | { type: 'MFA_SUBMITTED' }
  | { type: 'MFA_REJECTED' }
  | { type: 'MFA_OK' }
  | { type: 'DOCUMENT_READY' }
  | { type: 'CLOSE' }
  | { type: 'FAIL'; code: ErrorCode; retryable: boolean };

export const initialState: SessionState = { status: 'idle', mfaAttempts: 0 };

const TERMINAL: ReadonlySet<Status> = new Set(['done', 'failed']);

export function isTerminal(state: SessionState): boolean {
  return TERMINAL.has(state.status);
}

/** Allowed transitions for every event except FAIL, which is valid from any non-terminal state. */
const TRANSITIONS: Record<
  Exclude<SessionEvent['type'], 'FAIL'>,
  Partial<Record<Status, Status>>
> = {
  PREWARM: { idle: 'prewarming' },
  QUEUE: { idle: 'queued' },
  START_LOGIN: { idle: 'logging_in', queued: 'logging_in', prewarming: 'logging_in' },
  CHECK_SAVED_SESSION: {
    idle: 'checking_session',
    queued: 'checking_session',
    prewarming: 'checking_session',
  },
  FAST_PATH_HIT: { checking_session: 'fetching_docs' },
  FAST_PATH_MISS: { checking_session: 'logging_in' },
  LOGIN_OK: { logging_in: 'fetching_docs' },
  MFA_REQUESTED: { logging_in: 'mfa_required' },
  MFA_SUBMITTED: { mfa_required: 'verifying_mfa' },
  MFA_REJECTED: { verifying_mfa: 'mfa_required' },
  MFA_OK: { verifying_mfa: 'fetching_docs' },
  DOCUMENT_READY: { fetching_docs: 'document_ready' },
  CLOSE: {
    idle: 'done',
    queued: 'done',
    prewarming: 'done',
    // A carrier account with no documents: nothing to show, but not a failure.
    fetching_docs: 'done',
    document_ready: 'done',
  },
};

/**
 * Whether `event` is valid in `state`. The SessionManager uses this to ignore late events
 * (for example an MFA timeout that fires after the session already finished) instead of throwing.
 */
export function canTransition(state: SessionState, event: SessionEvent): boolean {
  if (isTerminal(state)) return false;
  if (event.type === 'FAIL') return true;
  return TRANSITIONS[event.type][state.status] !== undefined;
}

export function transition(state: SessionState, event: SessionEvent): SessionState {
  if (isTerminal(state)) {
    throw new AppError('INTERNAL', `No transitions out of '${state.status}' (got ${event.type})`);
  }

  if (event.type === 'FAIL') {
    return {
      status: 'failed',
      mfaAttempts: state.mfaAttempts,
      error: { code: event.code, retryable: event.retryable },
    };
  }

  const next = TRANSITIONS[event.type][state.status];
  if (!next) {
    throw new AppError('INTERNAL', `Invalid transition: ${event.type} in '${state.status}'`);
  }

  if (event.type === 'MFA_REJECTED') {
    const mfaAttempts = state.mfaAttempts + 1;
    if (mfaAttempts >= MAX_MFA_ATTEMPTS) {
      return { status: 'failed', mfaAttempts, error: { code: 'MFA_INVALID', retryable: false } };
    }
    return { status: next, mfaAttempts };
  }

  return { status: next, mfaAttempts: state.mfaAttempts };
}

/** Whether this session currently holds a browser slot (counts toward MAX_SESSIONS). */
export function holdsBrowserSlot(state: SessionState): boolean {
  return !isTerminal(state) && state.status !== 'idle' && state.status !== 'queued';
}
