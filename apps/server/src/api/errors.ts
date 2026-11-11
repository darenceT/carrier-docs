import type { ErrorBody } from '@carrier-docs/contracts';
import type { Context, Middleware } from 'koa';
import type { Logger } from 'pino';
import { z } from 'zod';
import { ERROR_INFO, isAppError, type ErrorCode } from '../core/errors.js';

/** The JSON body for an error response. Messages come from ERROR_INFO, so nothing internal leaks. */
export function errorBody(code: ErrorCode, message: string = ERROR_INFO[code].message): ErrorBody {
  return { error: { code, message, retryable: ERROR_INFO[code].retryable } };
}

export function sendError(ctx: Context, code: ErrorCode, message?: string): void {
  ctx.status = ERROR_INFO[code].status;
  ctx.body = errorBody(code, message);
}

/** Names the offending fields (never their values), e.g. "... Check: password." */
function describeZodError(err: z.ZodError): string {
  const fields = [...new Set(err.issues.map((i) => i.path.join('.') || '(body)'))];
  return `${ERROR_INFO.VALIDATION_FAILED.message} Check: ${fields.join(', ')}.`;
}

/** http-errors thrown for the client's fault, e.g. by @koa/bodyparser on bad or oversized JSON. */
function isClientHttpError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { status, expose } = err as { status?: unknown; expose?: unknown };
  return typeof status === 'number' && status >= 400 && status < 500 && expose === true;
}

/**
 * Maps every failure to ErrorBody: AppError -> its code and ERROR_INFO status; zod and client HTTP
 * errors -> VALIDATION_FAILED; anything else -> INTERNAL with the generic message. Details of
 * unknown errors go to the redacting log only, never to the response.
 */
export function errorMiddleware(logger: Logger): Middleware {
  return async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      const log = (ctx as { log?: Logger }).log ?? logger;
      if (isAppError(err)) {
        log.info({ code: err.code }, 'request failed');
        sendError(ctx, err.code);
      } else if (err instanceof z.ZodError) {
        log.info({ code: 'VALIDATION_FAILED' }, 'request failed validation');
        sendError(ctx, 'VALIDATION_FAILED', describeZodError(err));
      } else if (isClientHttpError(err)) {
        log.info({ code: 'VALIDATION_FAILED' }, 'request body rejected');
        sendError(ctx, 'VALIDATION_FAILED');
      } else {
        log.error({ code: 'INTERNAL', err }, 'unhandled error');
        sendError(ctx, 'INTERNAL');
      }
    }
  };
}
