/**
 * Stable error codes. Every failure in the system maps to one of these, so the UI,
 * logs and tests share one vocabulary. Extend this list here and nowhere else.
 */
export const ERROR_CODES = [
  'INVALID_CREDENTIALS',
  'MFA_REQUIRED',
  'MFA_INVALID',
  'MFA_TIMEOUT',
  'BLOCKED',
  'CARRIER_UNAVAILABLE',
  'SESSION_EXPIRED',
  'BUSY',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'VALIDATION_FAILED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

interface ErrorInfo {
  /** HTTP status when the error reaches the API. */
  status: number;
  /** Whether the user can sensibly try again as is. */
  retryable: boolean;
  /** Safe, user-facing message. Never include credentials or carrier page content. */
  message: string;
}

export const ERROR_INFO: Record<ErrorCode, ErrorInfo> = {
  INVALID_CREDENTIALS: {
    status: 401,
    retryable: false,
    message: 'The carrier rejected the username or password.',
  },
  MFA_REQUIRED: {
    status: 409,
    retryable: true,
    message: 'The carrier needs a verification code.',
  },
  MFA_INVALID: {
    status: 401,
    retryable: false,
    message: 'The verification code was not accepted.',
  },
  MFA_TIMEOUT: {
    status: 408,
    retryable: true,
    message: 'No verification code arrived in time. Start again.',
  },
  BLOCKED: {
    status: 503,
    retryable: false,
    message: "The carrier's bot protection blocked this login.",
  },
  CARRIER_UNAVAILABLE: {
    status: 502,
    retryable: true,
    message: "The carrier's portal did not respond as expected.",
  },
  SESSION_EXPIRED: { status: 410, retryable: true, message: 'This session has expired.' },
  BUSY: {
    status: 429,
    retryable: true,
    message: 'All login slots are busy. Try again in a minute.',
  },
  NOT_FOUND: { status: 404, retryable: false, message: 'Not found.' },
  UNAUTHORIZED: { status: 401, retryable: false, message: 'Access code required.' },
  RATE_LIMITED: {
    status: 429,
    retryable: true,
    message: 'Too many attempts. Wait a moment and try again.',
  },
  VALIDATION_FAILED: { status: 400, retryable: false, message: 'The request was not valid.' },
  INTERNAL: { status: 500, retryable: true, message: 'Something went wrong on our side.' },
};

/** An error that carries a stable code. Throw this from any layer; the API maps it to HTTP. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: ErrorCode, detail?: string, options?: { cause?: unknown }) {
    super(detail ?? ERROR_INFO[code].message, options);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_INFO[code].status;
    this.retryable = ERROR_INFO[code].retryable;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
