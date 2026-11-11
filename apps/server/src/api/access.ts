import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Context, Middleware } from 'koa';
import { AppError } from '../core/errors.js';

export const ACCESS_COOKIE = 'cd_access';
export const OWNER_COOKIE = 'cd_owner';

const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time comparison. Both sides are hashed first so inputs of different lengths are compared
 * as equal-length digests (timingSafeEqual throws on a length mismatch) without leaking the length.
 */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/**
 * The value stored in the access cookie: derived from the access code, so changing ACCESS_CODE
 * invalidates every existing cookie. The cookie is also signed with the app keys.
 */
function accessToken(accessCode: string): string {
  return createHash('sha256')
    .update(`cd_access:v1:${accessCode}`, 'utf8')
    .digest('base64url')
    .slice(0, 32);
}

export interface AccessGate {
  /** Sets the access cookie and, unless a valid one exists, a new owner cookie. */
  grant(ctx: Context): void;
  /** Middleware: 401 UNAUTHORIZED unless the signed access and owner cookies are valid. */
  require: Middleware;
}

export function createAccessGate(accessCode: string, secureCookies: boolean): AccessGate {
  const token = accessToken(accessCode);
  const cookieOptions = {
    signed: true,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: secureCookies,
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS,
    overwrite: true,
  };

  function readOwner(ctx: Context): string | undefined {
    const owner = ctx.cookies.get(OWNER_COOKIE, { signed: true });
    return owner && UUID_RE.test(owner) ? owner : undefined;
  }

  return {
    grant(ctx) {
      ctx.cookies.set(ACCESS_COOKIE, token, cookieOptions);
      ctx.cookies.set(OWNER_COOKIE, readOwner(ctx) ?? randomUUID(), cookieOptions);
    },

    async require(ctx, next) {
      const presented = ctx.cookies.get(ACCESS_COOKIE, { signed: true });
      const ownerId = readOwner(ctx);
      if (presented === undefined || !safeEqual(presented, token) || ownerId === undefined) {
        throw new AppError('UNAUTHORIZED');
      }
      ctx.state.ownerId = ownerId;
      await next();
    },
  };
}
