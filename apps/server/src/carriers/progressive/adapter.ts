import type { CarrierInfo, DocumentMeta } from '@carrier-docs/contracts';
import type { Locator, Page, Request, Response } from 'patchright';
import {
  BlockDetector,
  snapshotPage,
  verdictToErrorCode,
  type Pacing,
} from '../../antibot/index.js';
import { AppError } from '../../core/errors.js';
import type {
  CarrierAdapter,
  Credentials,
  DocumentContent,
  LoginOutcome,
} from '../../core/ports.js';
import { isBrowserGone } from '../../browser/errors.js';
import {
  type StepLog,
  describeShape,
  evaluateInPage,
  inPageFailure,
  maskPolicyNumber,
  sortDocuments,
  step,
} from '../shared.js';
import { idCardFromDocuments } from './document.js';
import { findPolicies, policyFromDocumentUrl, type Policy } from './policies.js';
import { PROGRESSIVE_URLS, blockRules, selectors, type ProgressiveUrls } from './selectors.js';

export const PROGRESSIVE_CARRIER: CarrierInfo = {
  id: 'progressive',
  name: 'Progressive',
  isDemo: false,
  loginFields: ['username', 'password'],
};

export interface ProgressiveAdapterOptions {
  pacing: Pacing;
  /** Override the real URLs; tests point these at a local imitation of the flow. */
  urls?: Partial<ProgressiveUrls>;
  /** Timeout for one carrier step (a page load, a login call). Default 30 s. */
  stepTimeoutMs?: number;
  /** Where sub-step timings go (timings and outcomes only, never values). */
  log?: StepLog;
  /** The ID cards page's path, if known; otherwise learned from the first click. */
  idCardsPath?: string;
}

type ClickResult = 'clicked' | 'not needed' | 'failed';

/** Milliseconds since it was made. */
const timer = () => {
  const start = Date.now();
  return () => Date.now() - start;
};

const MFA_HINT = 'Progressive texted a code to the phone on your account.';

interface Template {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * What Progressive's own page does, recorded per page from the moment it opens. The adapter reads
 * this instead of guessing: flow statuses, the app's API headers (its Bearer token lives only in
 * the page's memory) and the app's own ID-card request, used as a template. Memory only, never
 * logged.
 */
class Watch {
  statuses: string[] = [];
  credentialCheck?: number;
  otpChecks: number[] = [];
  apiHeaders?: Record<string, string>;
  /** Policies from the account handshake, once one listed any. */
  handshakePolicies?: Policy[];
  /** The handshake's shape (key names and types only) when it listed none: for the error. */
  handshakeShape?: string;
  template?: Template;
  /**
   * The app's own ID-card responses, by policy number: the status, and the JSON (base64 files) when it
   * succeeded. Memory only: these are the user's documents.
   */
  /** The policies the app has asked for an ID card for, in order. */
  appAsked: Policy[] = [];
  appCards = new Map<string, { status: number; json?: unknown }>();
}

const KEEP_HEADER = /^(authorization|accept|content-type|x-[a-z0-9-]+)$/i;

/**
 * Progressive: username + password, then an SMS code, then "remember this device". Documents come
 * from api.progressive.com with the app's own Bearer token; the ID card PDF is base64 in JSON
 * (design D1, docs/spike.md).
 */
export class ProgressiveAdapter implements CarrierAdapter<Page> {
  readonly info = PROGRESSIVE_CARRIER;
  private readonly urls: ProgressiveUrls;
  private readonly pacing: Pacing;
  private readonly timeout: number;
  private readonly log: StepLog;
  /** The ID cards page's path, from options or learned from the first click (see goToIdCards). */
  private idCardsPath: string | undefined;
  private readonly detector = new BlockDetector(blockRules);
  private readonly watches = new WeakMap<Page, Watch>();
  /** Document ID -> the policy it belongs to, per page. */
  private readonly policies = new WeakMap<Page, Map<string, Policy>>();

  constructor(options: ProgressiveAdapterOptions) {
    this.log = options.log ?? (() => undefined);
    this.idCardsPath = options.idCardsPath;
    this.urls = { ...PROGRESSIVE_URLS, ...options.urls };
    this.pacing = options.pacing;
    this.timeout = options.stepTimeoutMs ?? 30_000;
  }

  async openLogin(page: Page): Promise<void> {
    this.watch(page);
    await this.goto(page, this.urls.login);
    await this.field(page, selectors.username, 'username field');
  }

  async login(page: Page, credentials: Credentials): Promise<LoginOutcome> {
    const { username, password } = credentials;
    if (!username || !password) throw new AppError('VALIDATION_FAILED', 'username and password');
    const w = this.watch(page);
    if (!(await this.visible(page, selectors.username))) await this.openLogin(page);

    await step('login fields', async () => {
      await this.pacing.type(await this.field(page, selectors.username, 'username'), username);
      await this.pacing.type(await this.field(page, selectors.password, 'password'), password);
    });
    await step('sign-in button', () =>
      this.pacing.click(page.getByRole('button', { name: selectors.signIn }).first()),
    );

    // Next: the SMS step, straight into the account (device remembered), or a rejection. Some
    // versions first ask how to send the code; if the flow sits still for 3 s, choose text once.
    const started = Date.now();
    let choseText = false;
    const next = await this.until(page, () => {
      if (w.statuses.includes('OTP_REQUIRED')) return 'otp';
      if (this.onApp(page)) return 'in';
      if (w.credentialCheck !== undefined && w.credentialCheck >= 400) return 'rejected';
      if (!choseText && Date.now() - started > 3_000) {
        choseText = true;
        void page
          .getByRole('button', { name: selectors.sendText })
          .first()
          .click({ timeout: 2_000 })
          .catch(() => undefined);
      }
      return undefined;
    });

    if (next === 'otp') return { kind: 'mfa_required', hint: MFA_HINT };
    if (next === 'in') return { kind: 'ok' };
    if (next === 'rejected') {
      const status = w.credentialCheck;
      if (status === 403 || status === 429) return this.failure(page, status);
      return { kind: 'failed', code: 'BAD_CREDENTIALS' };
    }
    return this.failure(page);
  }

  async submitMfa(page: Page, code: string): Promise<LoginOutcome> {
    const w = this.watch(page);
    const t = timer();
    const checksBefore = w.otpChecks.length;
    const completedBefore = w.statuses.filter((s) => s === 'MFA_COMPLETED').length;

    const field = await this.field(page, selectors.code, 'code field');
    await step('code field', () => this.pacing.type(field, code));
    const typedMs = t();
    // The form may submit itself as soon as the code is entered. A Verify click must then not
    // wait on a button that is disabled or gone: it stops as soon as Progressive moves on.
    const verify = page.getByRole('button', { name: selectors.verify }).first();
    const moved = () =>
      w.statuses.filter((st) => st === 'MFA_COMPLETED').length > completedBefore ||
      w.otpChecks.length > checksBefore ||
      this.onApp(page);
    let verifyClick: ClickResult | 'enter' = 'not needed';
    if (!moved()) {
      if (await verify.isVisible().catch(() => false)) {
        verifyClick = await this.clickUnless(page, verify, moved);
      } else {
        verifyClick = 'enter';
        await field.press('Enter').catch(() => undefined);
      }
    }

    const result = await this.until(page, () => {
      if (w.statuses.filter((s) => s === 'MFA_COMPLETED').length > completedBefore) return 'ok';
      if (this.onApp(page)) return 'ok';
      const check = w.otpChecks[checksBefore];
      if (check !== undefined && check >= 400) return 'rejected';
      return undefined;
    });
    const verifiedMs = t();
    if (result === 'rejected') {
      const status = w.otpChecks[checksBefore];
      this.log('progressive mfa', { typedMs, verifyClick, verifiedMs, result: 'rejected' });
      if (status === 403 || status === 429) return this.failure(page, status);
      return { kind: 'mfa_required', hint: MFA_HINT, rejected: true };
    }
    if (result !== 'ok') {
      this.log('progressive mfa', { typedMs, verifyClick, verifiedMs, result: 'no answer' });
      return this.failure(page);
    }

    // "Remember this device": the box is custom-drawn and clicking its label is what works;
    // doing so moves straight on to the account. Bounded: an overlay that swallows the click
    // must not cost the full action timeout (it did: ~30 s per login).
    let remember: ClickResult | 'not shown' | 'forced' = 'not needed';
    if (!this.onApp(page)) {
      const label = page
        .locator('label')
        .filter({ hasText: selectors.remember })
        .or(page.getByText(selectors.remember))
        .first();
      const shown = await label.waitFor({ state: 'visible', timeout: 5_000 }).then(
        () => true,
        () => false,
      );
      if (!shown) remember = this.onApp(page) ? 'not needed' : 'not shown';
      else {
        remember = await this.clickUnless(page, label, () => this.onApp(page));
        if (remember === 'failed') {
          remember = 'forced';
          await label.click({ force: true, timeout: 2_000 }).catch(() => undefined);
        }
      }
    }
    const rememberMs = t();
    const inApp = await this.until(page, () => (this.onApp(page) ? true : undefined));
    this.log('progressive mfa', {
      typedMs,
      verifyClick,
      verifiedMs,
      remember,
      rememberMs,
      appMs: t(),
      result: inApp ? 'ok' : 'no account page',
    });
    return inApp ? { kind: 'ok' } : this.failure(page);
  }

  /**
   * Click `target` unless `done()` turns true first, never waiting more than `ms`. A click on a
   * button the page is replacing would otherwise wait the whole action timeout.
   */
  private async clickUnless(
    page: Page,
    target: Locator,
    done: () => boolean,
    ms = 4_000,
  ): Promise<ClickResult> {
    if (done()) return 'not needed';
    const click = this.pacing.click({ click: (o) => target.click({ ...o, timeout: ms }) }).then(
      () => 'clicked' as const,
      () => 'failed' as const,
    );
    const moved = this.until(page, () => (done() ? ('not needed' as const) : undefined), ms).then(
      (v) => v ?? ('failed' as const),
    );
    return Promise.race([click, moved]);
  }

  async isSessionValid(page: Page): Promise<boolean> {
    this.watch(page);
    await this.goto(page, this.urls.login);
    // Logged in: PingFederate redirects to the account. Not: the login form shows.
    const where = await this.until(page, async () => {
      if (this.onApp(page)) return 'app';
      if (await this.visible(page, selectors.username)) return 'login';
      return undefined;
    });
    return where === 'app';
  }

  async listDocuments(page: Page): Promise<DocumentMeta[]> {
    const w = this.watch(page);
    if (!this.onApp(page) && !(await this.isSessionValid(page))) {
      throw new AppError('SESSION_EXPIRED', 'not logged in');
    }
    const t = timer();
    await this.goToIdCards(page, w);
    const policies = await this.accountPolicies(page, w);
    this.log('progressive policies', { count: policies.length, ms: t() });
    const map = new Map<string, Policy>();
    const docs = policies.map((p, i): DocumentMeta => {
      const id = `idcard-${i + 1}`;
      map.set(id, p);
      const doc: DocumentMeta = {
        id,
        title: 'ID card',
        kind: 'id_card',
        mimeType: 'application/pdf',
      };
      const masked = maskPolicyNumber(p.number);
      if (masked) doc.policyNumberMasked = masked;
      return doc;
    });
    this.policies.set(page, map);
    return sortDocuments(docs);
  }

  async fetchDocument(page: Page, documentId: string): Promise<DocumentContent> {
    if (!this.policies.get(page)?.has(documentId)) await this.listDocuments(page);
    const policy = this.policies.get(page)?.get(documentId);
    if (!policy) throw new AppError('NOT_FOUND');
    const w = this.watch(page);
    const t = timer();
    const template = await this.documentTemplate(page);
    const done = (bytes: Uint8Array): DocumentContent => ({
      mimeType: 'application/pdf',
      filename: `progressive-${documentId}.pdf`,
      body: bytes,
    });

    // 1. The card the app itself just fetched for this policy (opening the ID cards page makes it
    //    ask). Proven to work on the real site, and already here: no request of ours at all.
    const ownFor = () => w.appCards.get(policy.number);
    if (w.appAsked.some((p) => p.number === policy.number)) {
      await this.until(page, () => ownFor(), 10_000);
    }
    const own = ownFor();
    this.log('progressive id card', {
      source: own && own.status >= 200 && own.status < 300 ? 'app' : 'ours',
      ownStatus: own?.status ?? 0,
      ms: t(),
    });
    if (own && own.status >= 200 && own.status < 300) {
      const c = timer();
      const bytes = await idCardFromDocuments(
        (own.json as { documents?: unknown } | undefined)?.documents,
      );
      this.log('progressive id card converted', {
        convertMs: c(),
        kb: Math.round(bytes.length / 1024),
      });
      return done(bytes);
    }

    // 2. A policy the app didn't fetch: our own request, built from the app's.
    const url = new URL(template.url);
    url.pathname = url.pathname.replace(
      /\/policies\/[^/]+\/document/,
      `/policies/${encodeURIComponent(policy.number)}/document`,
    );
    url.searchParams.set('policyInfoKey', policy.key);
    const body = JSON.stringify({ ...template.body, mimeType: 'pdf' });
    const res = await this.postDocument(page, url.href, template.headers, body);
    if (res.status < 200 || res.status >= 300) {
      // Not "session expired": the account answered a moment ago. Name what each side got.
      throw new AppError(
        res.status === 401 || res.status === 403 ? 'CARRIER_PAGE_CHANGED' : 'CARRIER_UNAVAILABLE',
        `document ${res.status}; app's own ${own ? own.status : 'none'}`,
      );
    }
    return done(await idCardFromDocuments((res.json as { documents?: unknown } | null)?.documents));
  }
  /**
   * The account's policies: from the handshake the app makes on load. If it lists none we can
   * read, the app's own ID-card request names a policy too, so use that (one ID card rather than
   * none). Only when both fail is the page changed, and the error names the handshake's shape.
   */
  private async accountPolicies(page: Page, w: Watch): Promise<Policy[]> {
    // Done waiting once the handshake answers, or once the app is already asking for ID cards
    // (on the ID cards page): those requests name the policies too.
    const seen = await this.until(
      page,
      () =>
        w.handshakePolicies ??
        (w.handshakeShape !== undefined || w.appAsked.length > 0 ? [] : undefined),
    );
    if (seen && seen.length > 0) return seen;
    try {
      await this.documentTemplate(page);
      // The first document waits for the app's first card anyway: until it arrives, a
      // handshake (the full policy list) may still come, and is preferred.
      await this.until(
        page,
        () =>
          w.handshakePolicies ??
          (w.appAsked.some((p) => w.appCards.has(p.number)) ? true : undefined),
        10_000,
      );
      const fromApp = w.appAsked;
      if (w.handshakePolicies) return w.handshakePolicies; // a later handshake listed them
      // Sorted: the app asks for cards concurrently, so arrival order varies between logins.
      if (fromApp.length > 0) {
        return [...fromApp].sort((a, b) =>
          a.number.localeCompare(b.number, undefined, { numeric: true }),
        );
      }
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'CARRIER_PAGE_CHANGED') throw err;
    }
    if (seen === null) throw new AppError('CARRIER_UNAVAILABLE', 'account handshake');
    throw new AppError('CARRIER_PAGE_CHANGED', `handshake shape ${w.handshakeShape ?? '?'}`);
  }

  /**
   * POST the ID-card request. First as the app sends it: from the page, Bearer token, no cookies
   * (the API is on another origin and authenticates by token; a cookie-carrying request can be
   * refused by its CORS policy). If the browser refuses that, or the API wants cookies after all
   * (401/403), retry with cookies. Last, from the browser context's request client, which CORS
   * doesn't apply to. The error names why each attempt failed (no values).
   */
  private async postDocument(
    page: Page,
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ status: number; json: unknown }> {
    const failures: string[] = [];
    for (const credentials of ['same-origin', 'include'] as const) {
      try {
        const res = await evaluateInPage(
          page,
          async ({ u, h, b, c }) => {
            const r = await fetch(u, { method: 'POST', headers: h, body: b, credentials: c });
            let json: unknown = null;
            try {
              json = await r.json();
            } catch {
              // not JSON: decided from the status
            }
            return { status: r.status, json };
          },
          { u: url, h: headers, b: body, c: credentials as RequestCredentials },
        );
        if ((res.status === 401 || res.status === 403) && credentials === 'same-origin') {
          failures.push(`page ${res.status}`);
          continue;
        }
        return res;
      } catch (err) {
        if (isBrowserGone(err)) throw new AppError('CARRIER_UNAVAILABLE', 'browser went away');
        failures.push(`page (${credentials}) ${inPageFailure(err)}`);
      }
    }
    try {
      const r = await page.context().request.post(url, {
        headers,
        data: body,
        timeout: this.timeout,
      });
      const json: unknown = await r.json().catch(() => null);
      return { status: r.status(), json };
    } catch (err) {
      failures.push(`context ${isBrowserGone(err) ? 'browser gone' : 'request failed'}`);
      throw new AppError('CARRIER_UNAVAILABLE', `document request: ${failures.join('; ')}`);
    }
  }

  // ---------- watching the page ----------

  private watch(page: Page): Watch {
    let w = this.watches.get(page);
    if (w) return w;
    const created = new Watch();
    w = created;
    this.watches.set(page, w);
    page.on('request', (req) => void this.onRequest(created, req));
    page.on('response', (res) => void this.onResponse(created, res));
    return w;
  }

  private async onRequest(w: Watch, req: Request): Promise<void> {
    if (!req.url().startsWith(this.urls.api)) return;
    const all = await req.allHeaders().catch(() => ({}) as Record<string, string>);
    const headers = Object.fromEntries(Object.entries(all).filter(([k]) => KEEP_HEADER.test(k)));
    if (headers.authorization) w.apiHeaders = headers;
    // The app's own ID-card request: the template for ours (its field values aren't documented).
    if (
      req.method() === 'POST' &&
      /\/policies\/[^/]+\/document/.test(new URL(req.url()).pathname)
    ) {
      try {
        const body = JSON.parse(req.postData() ?? '') as unknown;
        if (body && typeof body === 'object' && (body as { type?: unknown }).type === 'idCard') {
          w.template ??= { url: req.url(), headers, body: body as Record<string, unknown> };
          const asked = policyFromDocumentUrl(req.url());
          if (asked && !w.appAsked.some((p) => p.number === asked.number)) w.appAsked.push(asked);
        }
      } catch {
        // not JSON: not the request we want
      }
    }
  }

  private async onResponse(w: Watch, res: Response): Promise<void> {
    const url = res.url();
    if (url.includes(this.urls.pfFlows)) {
      const action = new URL(url).searchParams.get('action');
      if (action === 'checkUsernamePassword') w.credentialCheck = res.status();
      if (action === 'checkOtp') w.otpChecks.push(res.status());
      const body = (await res.json().catch(() => undefined)) as { status?: unknown } | undefined;
      if (typeof body?.status === 'string' && /^[A-Z_]{3,40}$/.test(body.status)) {
        w.statuses.push(body.status);
      }
      return;
    }
    if (url.startsWith(this.urls.api) && new URL(url).pathname.endsWith('/handshake') && res.ok()) {
      const body: unknown = await res.json().catch(() => 'not JSON');
      const found = findPolicies(body);
      if (found.length > 0) w.handshakePolicies ??= found;
      else w.handshakeShape ??= describeShape(body);
      return;
    }
    // The app's own ID-card response (not ours: ours are made with fetch in the page too, but
    // only after appCards is read, and a later one never replaces the app's).
    const card = policyFromDocumentUrl(url);
    if (url.startsWith(this.urls.api) && card && res.request().method() === 'POST') {
      let type: unknown;
      try {
        type = (JSON.parse(res.request().postData() ?? '') as { type?: unknown }).type;
      } catch {
        return;
      }
      if (type !== 'idCard' || w.appCards.has(card.number)) return;
      const ok = res.ok();
      const json: unknown = ok ? await res.json().catch(() => undefined) : undefined;
      w.appCards.set(card.number, { status: res.status(), json });
    }
  }

  /**
   * Once the ID cards page's path is known, open it straight away instead of rendering the
   * account home and clicking through (that cost ~7 s on the real site). The app boots on that
   * page and asks for the cards itself. A failed navigation is ignored: the click path remains.
   */
  private async goToIdCards(page: Page, w: Watch): Promise<void> {
    if (!this.idCardsPath || w.template || !this.onApp(page)) return;
    if (new URL(page.url()).pathname === this.idCardsPath) return;
    const target = new URL(this.idCardsPath, this.urls.appOrigin).href;
    await page.goto(target, { waitUntil: 'commit', timeout: this.timeout }).catch(() => undefined);
  }

  /** The app's own ID-card request. If it hasn't made one yet, open the ID cards page so it does. */
  private async documentTemplate(page: Page): Promise<Template> {
    const w = this.watch(page);
    if (w.template) return w.template;
    const link = page
      .getByRole('link', { name: selectors.idCards })
      .or(page.getByRole('button', { name: selectors.idCards }))
      .first();
    const t = timer();
    const before = new URL(page.url()).pathname;
    const clicked = await this.clickUnless(
      page,
      link,
      () => w.template !== undefined,
      this.timeout,
    );
    const clickMs = t();
    const template = await this.until(page, () => w.template);
    const after = new URL(page.url()).pathname;
    // Learn where the ID cards page is, so later logins go straight there (see goToIdCards).
    if (template && this.onApp(page) && after !== before) this.idCardsPath ??= after;
    this.log('progressive id cards page', {
      clicked,
      clickMs,
      requestMs: t(),
      found: !!template,
      // Digits masked: a path could in principle carry an ID.
      path: after.replace(/[0-9]/g, '#'),
    });
    if (!template && clicked === 'failed')
      throw new AppError('CARRIER_PAGE_CHANGED', 'ID cards link');
    if (!template) throw new AppError('CARRIER_PAGE_CHANGED', 'no ID card request from the app');
    return template;
  }

  // ---------- helpers ----------

  private onApp(page: Page): boolean {
    try {
      const u = new URL(page.url());
      return (
        u.origin === new URL(this.urls.appOrigin).origin &&
        u.pathname.startsWith(this.urls.appPathPrefix)
      );
    } catch {
      return false;
    }
  }

  /** Polls `check` until it returns a value; null on timeout. Throws on a block page. */
  private async until<T>(
    page: Page,
    check: () => T | undefined | Promise<T | undefined>,
    timeoutMs = this.timeout,
  ): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await check();
      if (v !== undefined) return v;
      await page.waitForTimeout(200);
    }
    return null;
  }

  private locator(page: Page, q: { css: readonly string[]; label: RegExp }): Locator {
    return page.locator(q.css.join(', ')).or(page.getByLabel(q.label)).first();
  }

  private async visible(
    page: Page,
    q: { css: readonly string[]; label: RegExp },
  ): Promise<boolean> {
    return this.locator(page, q)
      .isVisible()
      .catch(() => false);
  }

  private async field(
    page: Page,
    q: { css: readonly string[]; label: RegExp },
    what: string,
  ): Promise<Locator> {
    const loc = this.locator(page, q);
    await step(what, () => loc.waitFor({ state: 'visible', timeout: this.timeout }));
    return loc;
  }

  private async goto(page: Page, url: string): Promise<void> {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
    } catch {
      throw new AppError('CARRIER_UNAVAILABLE', `could not load ${new URL(url).pathname}`);
    }
  }

  /** Not where a successful step lands: ask the BlockDetector why. */
  private async failure(page: Page, status?: number): Promise<LoginOutcome> {
    const verdict = this.detector.classify(await snapshotPage(page, status));
    return {
      kind: 'failed',
      code: verdictToErrorCode(verdict === 'ok' ? 'page_changed' : verdict),
    };
  }
}
