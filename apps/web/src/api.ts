import type {
  CarriersResponse,
  ErrorBody,
  ErrorCode,
  ForgetResponse,
  MfaRequest,
  PrewarmRequest,
  SessionCreated,
  SessionSnapshot,
  StartSessionRequest,
} from '@carrier-docs/contracts';

/** A failed API call, parsed from the contract's ErrorBody (or synthesized when there is none). */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  /** HTTP status, or 0 when the server could not be reached. */
  readonly status: number;

  constructor(code: ErrorCode, message: string, retryable: boolean, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'BAD_CREDENTIALS',
  'MFA_INVALID',
  'MFA_TIMEOUT',
  'CARRIER_BLOCKED',
  'CARRIER_CHALLENGE',
  'CARRIER_PAGE_CHANGED',
  'CARRIER_UNAVAILABLE',
  'SESSION_EXPIRED',
  'BUSY',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'VALIDATION_FAILED',
  'INTERNAL',
]);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value);
}

function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  const e = error as Record<string, unknown>;
  return isErrorCode(e.code) && typeof e.message === 'string' && typeof e.retryable === 'boolean';
}

/** Used when a non-2xx response has no parseable ErrorBody (e.g. a proxy error page). */
function fallbackError(status: number): ApiError {
  if (status === 401) return new ApiError('UNAUTHORIZED', 'Access code required', false, status);
  if (status === 404) return new ApiError('NOT_FOUND', 'Not found', false, status);
  if (status === 429) return new ApiError('RATE_LIMITED', 'Too many requests', true, status);
  if (status === 400 || status === 422) {
    return new ApiError('VALIDATION_FAILED', 'Invalid request', false, status);
  }
  return new ApiError('INTERNAL', `Server error (HTTP ${status})`, status >= 500, status);
}

/** Turns a non-2xx Response into an ApiError. Exported for tests. */
export async function parseErrorResponse(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return fallbackError(res.status);
  }
  if (!isErrorBody(body)) return fallbackError(res.status);
  return new ApiError(body.error.code, body.error.message, body.error.retryable, res.status);
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface Api {
  access(code: string): Promise<void>;
  carriers(): Promise<CarriersResponse>;
  prewarm(body: PrewarmRequest): Promise<SessionCreated>;
  startSession(body: StartSessionRequest): Promise<SessionCreated>;
  submitMfa(sessionId: string, body: MfaRequest): Promise<void>;
  forgetMe(): Promise<ForgetResponse>;
  eventsUrl(sessionId: string): string;
  /** The polling fallback: the events a new SSE stream would start with. */
  sessionSnapshot(sessionId: string): Promise<SessionSnapshot>;
  documentUrl(sessionId: string, docId: string): string;
}

export function createApi(fetchFn: FetchFn = (input, init) => fetch(input, init)): Api {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchFn(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError('INTERNAL', 'Could not reach the server', true, 0);
    }
    if (!res.ok) throw await parseErrorResponse(res);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const sessionPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;

  return {
    access: (code) => request<void>('POST', '/api/access', { code }),
    carriers: () => request<CarriersResponse>('GET', '/api/carriers'),
    prewarm: (body) => request<SessionCreated>('POST', '/api/sessions/prewarm', body),
    startSession: (body) => request<SessionCreated>('POST', '/api/sessions', body),
    submitMfa: (id, body) => request<void>('POST', `${sessionPath(id)}/mfa`, body),
    forgetMe: () => request<ForgetResponse>('DELETE', '/api/me'),
    eventsUrl: (id) => `${sessionPath(id)}/events`,
    sessionSnapshot: (id) => request<SessionSnapshot>('GET', `${sessionPath(id)}/snapshot`),
    documentUrl: (id, docId) => `${sessionPath(id)}/documents/${encodeURIComponent(docId)}`,
  };
}

/** Normalizes anything thrown into an ApiError. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL', 'Something went wrong', true, 0);
}

const FRIENDLY: Record<ErrorCode, string> = {
  BAD_CREDENTIALS: 'The carrier did not accept that username or password.',
  MFA_INVALID: 'That verification code was not accepted.',
  MFA_TIMEOUT: 'The verification code was not entered in time.',
  CARRIER_BLOCKED: 'The carrier blocked this automated login. Try again later.',
  CARRIER_CHALLENGE:
    'The carrier asked for a check we cannot complete automatically. Try again later.',
  CARRIER_PAGE_CHANGED: 'The carrier changed its site and this login needs an update.',
  CARRIER_UNAVAILABLE: 'The carrier site is not responding right now. Try again shortly.',
  SESSION_EXPIRED: 'This session expired. Start over.',
  BUSY: 'All login slots are busy, try again in a minute.',
  NOT_FOUND: 'Not found. The session may have ended; start over.',
  UNAUTHORIZED: 'An access code is required.',
  RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
  VALIDATION_FAILED: 'Some of the details entered are not valid.',
  INTERNAL: 'Something went wrong on our side.',
};

export function friendlyError(code: ErrorCode): string {
  return FRIENDLY[code];
}
