import { AppError, type ErrorCode } from './errors.js';

/**
 * The login session state machine: a pure function, (state, event) -> new state.
 * No I/O, no timers. The SessionManager feeds it events and acts on the result.
 *
 *   idle -> prewarming -> logging_in -> mfa_required <-> verifying_mfa -> fetching_docs
 *        \______________/       \_______________ (no MFA) ______________/      |
 *   idle --(saved session valid)----------------------------------------> fetching_docs
 *   fetching_docs -> document_ready -> done          any active state -> failed
 */
export const STATUSES = [
  'idle',
  'prewarming',
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
  | { type: 'START_LOGIN' }
  /** A saved session was found and accepted by the carrier: skip login and MFA. */
  | { type: 'FAST_PATH_HIT' }
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
  START_LOGIN: { idle: 'logging_in', prewarming: 'logging_in' },
  FAST_PATH_HIT: { idle: 'fetching_docs' },
  LOGIN_OK: { logging_in: 'fetching_docs' },
  MFA_REQUESTED: { logging_in: 'mfa_required' },
  MFA_SUBMITTED: { mfa_required: 'verifying_mfa' },
  MFA_REJECTED: { verifying_mfa: 'mfa_required' },
  MFA_OK: { verifying_mfa: 'fetching_docs' },
  DOCUMENT_READY: { fetching_docs: 'document_ready' },
  CLOSE: {
    idle: 'done',
    prewarming: 'done',
    document_ready: 'done',
  },
};

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
  return !isTerminal(state) && state.status !== 'idle';
}
