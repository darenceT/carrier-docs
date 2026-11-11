import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { bodyParser } from '@koa/bodyparser';
import Router from '@koa/router';
import Koa, { type Context } from 'koa';
import { MOCK_DOCUMENTS, MOCK_INSURED_NAME, MOCK_POLICIES } from './data.js';
import { blockedPage, dashboardPage, loginPage, mfaPage, tooManyAttemptsPage } from './html.js';
import { buildPdf } from './pdf.js';

export const MOCK_PORTAL_BASE_PATH = '/demo-portal';

/** The MFA code the mock portal accepts. Safe to publish: it only unlocks fixture data. */
export const MOCK_PORTAL_MFA_CODE = '123456';

/** Usernames that make the portal misbehave in a specific way. Any password works for these. */
export const MOCK_PORTAL_USERNAMES = {
  wrongPassword: 'demo-wrongpass',
  blocked: 'demo-blocked',
  slow: 'demo-slow',
  noMfa: 'demo-nomfa',
} as const;

export const MOCK_PORTAL_COOKIES = {
  session: 'demo_session',
  pendingLogin: 'demo_pending_login',
  deviceTrust: 'device_trust',
} as const;

export const MOCK_PORTAL_MAX_MFA_ATTEMPTS = 3;

export interface MockPortalOptions {
  /** Where the routes live. Default MOCK_PORTAL_BASE_PATH. Use '' to serve at the root. */
  basePath?: string;
  /** The MFA code accepted. Default MOCK_PORTAL_MFA_CODE. */
  mfaCode?: string;
  /** How long `demo-slow` waits before continuing. Default 3000 ms. */
  slowMs?: number;
}

const FORM_TOKEN_TTL_MS = 30 * 60_000;
const PENDING_LOGIN_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 60 * 60_000;
const DEVICE_TRUST_TTL_MS = 30 * 24 * 60 * 60_000;

/** A Map whose entries expire. Expired entries are pruned lazily on access and insert. */
class ExpiringMap<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  constructor(private readonly ttlMs: number) {}

  set(key: string, value: V): void {
    this.prune();
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  get(key: string | undefined): V | undefined {
    if (key === undefined) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  delete(key: string | undefined): void {
    if (key !== undefined) this.entries.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

function newToken(): string {
  return randomBytes(18).toString('base64url');
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.replace(/\/+$/, '');
  if (trimmed === '') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function formField(ctx: Context, name: string): string {
  const body = ctx.request.body;
  if (body && typeof body === 'object' && name in body) {
    const value = (body as Record<string, unknown>)[name];
    if (typeof value === 'string') return value;
  }
  return '';
}

/**
 * The mock carrier portal as a router. Mount it with `app.use(router.routes())`; every route
 * lives under `basePath`. State (sessions, pending logins, trusted devices) is per instance.
 */
export function createMockPortalRouter(options: MockPortalOptions = {}): Router {
  const base = normalizeBasePath(options.basePath ?? MOCK_PORTAL_BASE_PATH);
  const mfaCode = options.mfaCode ?? MOCK_PORTAL_MFA_CODE;
  const slowMs = options.slowMs ?? 3000;
  const cookiePath = base || '/';

  const formTokens = new ExpiringMap<true>(FORM_TOKEN_TTL_MS);
  const pendingLogins = new ExpiringMap<{ username: string; attempts: number }>(
    PENDING_LOGIN_TTL_MS,
  );
  const sessions = new ExpiringMap<{ username: string }>(SESSION_TTL_MS);
  const trustedDevices = new ExpiringMap<{ username: string }>(DEVICE_TRUST_TTL_MS);

  const router = base ? new Router({ prefix: base }) : new Router();
  router.use(bodyParser({ enableTypes: ['form', 'json'] }));

  const setCookie = (ctx: Context, name: string, value: string, maxAge: number): void => {
    ctx.cookies.set(name, value, { httpOnly: true, sameSite: 'lax', path: cookiePath, maxAge });
  };
  const clearCookie = (ctx: Context, name: string): void => {
    ctx.cookies.set(name, '', { httpOnly: true, sameSite: 'lax', path: cookiePath, maxAge: 0 });
  };

  const renderLogin = (ctx: Context, error?: string, username?: string): void => {
    const formToken = newToken();
    formTokens.set(formToken, true);
    ctx.set('Cache-Control', 'no-store');
    ctx.type = 'html';
    ctx.body = loginPage({ base, formToken, error, username });
  };

  const startSession = (ctx: Context, username: string): void => {
    const sid = newToken();
    sessions.set(sid, { username });
    setCookie(ctx, MOCK_PORTAL_COOKIES.session, sid, SESSION_TTL_MS);
    clearCookie(ctx, MOCK_PORTAL_COOKIES.pendingLogin);
    ctx.redirect(`${base}/dashboard`);
  };

  const currentSession = (ctx: Context) =>
    sessions.get(ctx.cookies.get(MOCK_PORTAL_COOKIES.session));

  router.get('/', (ctx) => {
    ctx.redirect(currentSession(ctx) ? `${base}/dashboard` : `${base}/login`);
  });

  router.get('/login', (ctx) => {
    renderLogin(ctx);
  });

  router.post('/login', async (ctx) => {
    const formToken = formField(ctx, 'formToken');
    const username = formField(ctx, 'username').trim();
    const password = formField(ctx, 'password');

    if (!formToken || !formTokens.get(formToken)) {
      ctx.status = 400;
      renderLogin(ctx, 'Your sign-in form expired. Please try again.', username);
      return;
    }
    formTokens.delete(formToken);

    if (!username || !password) {
      renderLogin(ctx, 'Enter your username and password.', username);
      return;
    }
    if (username === MOCK_PORTAL_USERNAMES.wrongPassword) {
      renderLogin(ctx, 'Invalid username or password', username);
      return;
    }
    if (username === MOCK_PORTAL_USERNAMES.blocked) {
      ctx.status = 403;
      ctx.type = 'html';
      ctx.body = blockedPage();
      return;
    }
    if (username === MOCK_PORTAL_USERNAMES.slow) {
      await sleep(slowMs);
    }
    if (username === MOCK_PORTAL_USERNAMES.noMfa) {
      startSession(ctx, username);
      return;
    }

    const trusted = trustedDevices.get(ctx.cookies.get(MOCK_PORTAL_COOKIES.deviceTrust));
    if (trusted && trusted.username === username) {
      startSession(ctx, username);
      return;
    }

    const pendingId = newToken();
    pendingLogins.set(pendingId, { username, attempts: 0 });
    setCookie(ctx, MOCK_PORTAL_COOKIES.pendingLogin, pendingId, PENDING_LOGIN_TTL_MS);
    ctx.redirect(`${base}/mfa`);
  });

  router.get('/mfa', (ctx) => {
    if (!pendingLogins.get(ctx.cookies.get(MOCK_PORTAL_COOKIES.pendingLogin))) {
      ctx.redirect(`${base}/login`);
      return;
    }
    ctx.set('Cache-Control', 'no-store');
    ctx.type = 'html';
    ctx.body = mfaPage({ base });
  });

  router.post('/mfa', (ctx) => {
    const pendingId = ctx.cookies.get(MOCK_PORTAL_COOKIES.pendingLogin);
    const pending = pendingLogins.get(pendingId);
    if (!pendingId || !pending) {
      ctx.redirect(`${base}/login`);
      return;
    }

    const code = formField(ctx, 'code').trim();
    if (code === mfaCode) {
      pendingLogins.delete(pendingId);
      if (formField(ctx, 'remember')) {
        const deviceToken = newToken();
        trustedDevices.set(deviceToken, { username: pending.username });
        setCookie(ctx, MOCK_PORTAL_COOKIES.deviceTrust, deviceToken, DEVICE_TRUST_TTL_MS);
      }
      startSession(ctx, pending.username);
      return;
    }

    pending.attempts += 1;
    ctx.set('Cache-Control', 'no-store');
    ctx.type = 'html';
    if (pending.attempts >= MOCK_PORTAL_MAX_MFA_ATTEMPTS) {
      pendingLogins.delete(pendingId);
      clearCookie(ctx, MOCK_PORTAL_COOKIES.pendingLogin);
      ctx.body = tooManyAttemptsPage(base);
      return;
    }
    const left = MOCK_PORTAL_MAX_MFA_ATTEMPTS - pending.attempts;
    ctx.body = mfaPage({
      base,
      error: `That code didn't work. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`,
    });
  });

  router.get('/dashboard', (ctx) => {
    if (!currentSession(ctx)) {
      ctx.redirect(`${base}/login`);
      return;
    }
    ctx.set('Cache-Control', 'no-store');
    ctx.type = 'html';
    ctx.body = dashboardPage({ base, policies: MOCK_POLICIES, documents: MOCK_DOCUMENTS });
  });

  const requireApiSession = (ctx: Context): boolean => {
    if (currentSession(ctx)) return true;
    ctx.status = 401;
    ctx.body = { error: 'not_authenticated', message: 'Sign in to continue.' };
    return false;
  };

  router.get('/api/documents', (ctx) => {
    if (!requireApiSession(ctx)) return;
    ctx.set('Cache-Control', 'no-store');
    ctx.body = {
      documents: MOCK_DOCUMENTS.map((d) => ({
        id: d.id,
        title: d.title,
        kind: d.kind,
        policyNumber: d.policyNumber,
        url: `${base}/api/documents/${d.id}/download`,
      })),
    };
  });

  router.get('/api/documents/:id/download', (ctx) => {
    if (!requireApiSession(ctx)) return;
    const doc = MOCK_DOCUMENTS.find((d) => d.id === ctx.params.id);
    if (!doc) {
      ctx.status = 404;
      ctx.body = { error: 'not_found', message: 'No such document.' };
      return;
    }
    ctx.set('Cache-Control', 'no-store');
    ctx.set('Content-Disposition', `attachment; filename="${doc.filename}"`);
    ctx.type = 'application/pdf';
    ctx.body = buildPdf(
      [
        { text: `DEMO INSURANCE - ${doc.title} - TEST FIXTURE, NOT A REAL POLICY`, size: 13 },
        { text: doc.title, size: 20 },
        { text: `Policy number: ${doc.policyNumber}` },
        { text: `Named insured: ${MOCK_INSURED_NAME}` },
        { text: 'This document was generated by the carrier-docs mock portal.' },
        { text: 'It is not proof of insurance and has no legal effect.' },
      ],
      `DEMO INSURANCE - ${doc.title}`,
    );
  });

  router.post('/logout', (ctx) => {
    sessions.delete(ctx.cookies.get(MOCK_PORTAL_COOKIES.session));
    clearCookie(ctx, MOCK_PORTAL_COOKIES.session);
    ctx.redirect(`${base}/login`);
  });

  return router;
}

/** A standalone Koa app serving the mock portal, for local runs and tests. */
export function createMockPortalApp(options: MockPortalOptions = {}): Koa {
  const app = new Koa();
  const router = createMockPortalRouter(options);
  app.use(router.routes()).use(router.allowedMethods());
  return app;
}
