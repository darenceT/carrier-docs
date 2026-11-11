import type {
  CarrierInfo,
  DocumentMeta,
  ErrorCode,
  SessionEvent,
  SessionStatus,
  StepTiming,
} from '@carrier-docs/contracts';

/** All UI and session state. Pure data; the reducer below is the only thing that changes it. */
export interface State {
  /** Some API call returned 401: show the access-code form. */
  needsAccess: boolean;
  accessSubmitting: boolean;
  accessError?: string;

  carriers: CarrierInfo[] | null;
  carriersError?: string;

  carrierId: string;
  prewarmSessionId?: string;
  username: string;
  /** Only held while the user types; cleared the moment the login POST is sent. */
  password: string;
  loginSubmitting: boolean;
  loginError?: { code: ErrorCode; message: string };

  sessionId?: string;
  /** Client clock (ms) when the session was started, for the live elapsed timer. */
  startedAt?: number;
  clientElapsedMs?: number;
  status?: SessionStatus;
  timings: StepTiming[];
  serverElapsedMs?: number;

  mfa?: { hint?: string; attemptsLeft: number; lastAttemptRejected: boolean };
  mfaCode: string;
  mfaSubmitting: boolean;
  mfaError?: { code: ErrorCode; message: string };

  documents: DocumentMeta[];
  readyDocumentId?: string;
  /** document_ready.elapsedMs: the headline "First document in X.X s". */
  firstDocumentMs?: number;
  selectedDocumentId?: string;

  failure?: { code: ErrorCode; message: string; retryable: boolean };
  /** Set by done or failed: the event stream is over. */
  finished: boolean;

  /** Result of the last "Forget me". */
  forgotten?: number;
  forgetError?: string;
}

export const initialState: State = {
  needsAccess: false,
  accessSubmitting: false,
  carriers: null,
  carrierId: '',
  username: '',
  password: '',
  loginSubmitting: false,
  timings: [],
  mfaCode: '',
  mfaSubmitting: false,
  documents: [],
  finished: false,
};

type RequestError = { code: ErrorCode; message: string };

export type UiAction =
  | { type: 'access_required' }
  | { type: 'access_submitted' }
  | { type: 'access_granted' }
  | { type: 'access_failed'; message: string }
  | { type: 'carriers_loaded'; carriers: CarrierInfo[] }
  | { type: 'carriers_failed'; message: string }
  | { type: 'carrier_selected'; carrierId: string }
  | { type: 'prewarmed'; carrierId: string; sessionId: string }
  | { type: 'field_changed'; field: 'username' | 'password' | 'mfaCode'; value: string }
  | { type: 'login_submitted' }
  | { type: 'session_started'; sessionId: string; at: number }
  | { type: 'login_failed'; error: RequestError }
  | { type: 'mfa_submitted' }
  | { type: 'mfa_accepted' }
  | { type: 'mfa_post_failed'; error: RequestError }
  | { type: 'stream_lost' }
  | { type: 'tick'; now: number }
  | { type: 'document_selected'; documentId: string }
  | { type: 'try_again' }
  | { type: 'start_over' }
  | { type: 'forgotten'; deleted: number }
  | { type: 'forget_failed'; message: string };

export type Action = SessionEvent | UiAction;

/** Clears everything about the current session attempt (keeps access, carriers, form choices). */
function clearSession(state: State): State {
  return {
    ...state,
    password: '',
    loginSubmitting: false,
    loginError: undefined,
    sessionId: undefined,
    startedAt: undefined,
    clientElapsedMs: undefined,
    status: undefined,
    timings: [],
    serverElapsedMs: undefined,
    mfa: undefined,
    mfaCode: '',
    mfaSubmitting: false,
    mfaError: undefined,
    documents: [],
    readyDocumentId: undefined,
    firstDocumentMs: undefined,
    selectedDocumentId: undefined,
    failure: undefined,
    finished: false,
  };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    // ---------- access ----------
    case 'access_required':
      return {
        ...state,
        needsAccess: true,
        accessSubmitting: false,
        loginSubmitting: false,
        mfaSubmitting: false,
      };
    case 'access_submitted':
      return { ...state, accessSubmitting: true, accessError: undefined };
    case 'access_granted':
      return { ...state, needsAccess: false, accessSubmitting: false, accessError: undefined };
    case 'access_failed':
      return { ...state, accessSubmitting: false, accessError: action.message };

    // ---------- carrier and login form ----------
    case 'carriers_loaded':
      return { ...state, carriers: action.carriers, carriersError: undefined };
    case 'carriers_failed':
      return { ...state, carriersError: action.message };
    case 'carrier_selected':
      return { ...state, carrierId: action.carrierId, prewarmSessionId: undefined };
    case 'prewarmed':
      // Ignore a late prewarm for a carrier the user has moved away from, or after login began.
      if (action.carrierId !== state.carrierId || state.sessionId || state.loginSubmitting) {
        return state;
      }
      return { ...state, prewarmSessionId: action.sessionId };
    case 'field_changed':
      return { ...state, [action.field]: action.value };
    case 'login_submitted':
      return { ...state, password: '', loginSubmitting: true, loginError: undefined };
    case 'session_started':
      return {
        ...clearSession(state),
        sessionId: action.sessionId,
        startedAt: action.at,
        clientElapsedMs: 0,
        prewarmSessionId: undefined,
      };
    case 'login_failed':
      return { ...state, password: '', loginSubmitting: false, loginError: action.error };

    // ---------- MFA ----------
    case 'mfa_submitted':
      return { ...state, mfaCode: '', mfaSubmitting: true, mfaError: undefined };
    case 'mfa_accepted':
      // 202: the code was handed to the carrier; the stream reports the outcome.
      return state;
    case 'mfa_post_failed':
      return { ...state, mfaSubmitting: false, mfaError: action.error };

    // ---------- session events (SSE) ----------
    case 'status': {
      if (state.finished) return state;
      const leftMfa = action.status !== 'mfa_required' && action.status !== 'verifying_mfa';
      return {
        ...state,
        status: action.status,
        timings: action.timings,
        serverElapsedMs: action.elapsedMs,
        mfa: leftMfa ? undefined : state.mfa,
        mfaSubmitting:
          action.status === 'verifying_mfa' ? true : leftMfa ? false : state.mfaSubmitting,
      };
    }
    case 'mfa_required':
      if (state.finished) return state;
      return {
        ...state,
        status: 'mfa_required',
        mfa: {
          hint: action.hint,
          attemptsLeft: action.attemptsLeft,
          lastAttemptRejected: action.lastAttemptRejected,
        },
        mfaSubmitting: false,
        mfaCode: '',
      };
    case 'documents_listed':
      return { ...state, documents: action.documents };
    case 'document_ready':
      return {
        ...state,
        readyDocumentId: action.documentId,
        firstDocumentMs: state.firstDocumentMs ?? action.elapsedMs,
        selectedDocumentId: state.selectedDocumentId ?? action.documentId,
      };
    case 'failed':
      return {
        ...state,
        status: 'failed',
        failure: { code: action.code, message: action.message, retryable: action.retryable },
        mfa: undefined,
        mfaSubmitting: false,
        finished: true,
      };
    case 'done':
      return { ...state, status: 'done', mfa: undefined, mfaSubmitting: false, finished: true };
    case 'stream_lost':
      if (state.finished || !state.sessionId) return state;
      return {
        ...state,
        status: 'failed',
        failure: { code: 'INTERNAL', message: 'Lost connection to the server.', retryable: true },
        mfa: undefined,
        mfaSubmitting: false,
        finished: true,
      };

    // ---------- misc UI ----------
    case 'tick':
      if (state.finished || state.startedAt === undefined) return state;
      return { ...state, clientElapsedMs: Math.max(0, action.now - state.startedAt) };
    case 'document_selected':
      return { ...state, selectedDocumentId: action.documentId };
    case 'try_again':
      return { ...clearSession(state), prewarmSessionId: undefined };
    case 'start_over':
      return {
        ...initialState,
        carriers: state.carriers,
        needsAccess: state.needsAccess,
      };
    case 'forgotten':
      return { ...initialState, carriers: state.carriers, forgotten: action.deleted };
    case 'forget_failed':
      return { ...state, forgetError: action.message };
  }
}

/** Which main screen to show. Derived, so it can never disagree with the state. */
export type Screen = 'access' | 'login' | 'starting' | 'mfa' | 'waiting' | 'documents' | 'failed';

export function screenOf(state: State): Screen {
  if (state.needsAccess) return 'access';
  if (state.failure) return 'failed';
  if (!state.sessionId) return state.loginSubmitting ? 'starting' : 'login';
  if (state.documents.length > 0) return 'documents';
  if (state.mfa && !state.mfaSubmitting) return 'mfa';
  return 'waiting';
}

const STATUS_TEXT: Record<SessionStatus, string> = {
  idle: 'Idle',
  prewarming: 'Opening the carrier site',
  logging_in: 'Logging in',
  mfa_required: 'Waiting for your verification code',
  verifying_mfa: 'Checking the code',
  fetching_docs: 'Fetching documents',
  document_ready: 'First document ready',
  done: 'Done',
  failed: 'Failed',
};

export function statusText(status: SessionStatus): string {
  return STATUS_TEXT[status];
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
