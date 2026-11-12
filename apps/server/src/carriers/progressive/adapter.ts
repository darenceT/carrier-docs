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
import { describeShape, maskPolicyNumber, sortDocuments, step } from '../shared.js';
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
}

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
  private readonly detector = new BlockDetector(blockRules);
  private readonly watches = new WeakMap<Page, Watch>();
  /** Document ID -> the policy it belongs to, per page. */
  private readonly policies = new WeakMap<Page, Map<string, Policy>>();

  constructor(options: ProgressiveAdapterOptions) {
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
    const checksBefore = w.otpChecks.length;
    const completedBefore = w.statuses.filter((s) => s === 'MFA_COMPLETED').length;

    const field = await this.field(page, selectors.code, 'code field');
    await step('code field', () => this.pacing.type(field, code));
    // The form may submit itself or move on as soon as the code is entered; a Verify click on a
    // button that has just gone must not fail the login. Progressive's own status decides below.
    const verify = page.getByRole('button', { name: selectors.verify }).first();
    const moved = () =>
      w.statuses.filter((st) => st === 'MFA_COMPLETED').length > completedBefore ||
      w.otpChecks.length > checksBefore ||
      this.onApp(page);
    if (!moved()) {
      if (await verify.isVisible().catch(() => false)) {
        await this.pacing.click(verify).catch(() => undefined);
      } else {
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
    if (result === 'rejected') {
      const status = w.otpChecks[checksBefore];
      if (status === 403 || status === 429) return this.failure(page, status);
      return { kind: 'mfa_required', hint: MFA_HINT, rejected: true };
    }
    if (result !== 'ok') return this.failure(page);

    // "Remember this device": on the real page the box is custom-drawn and clicking its label is
    // what works; doing so moves straight on to the account.
    if (!this.onApp(page)) {
      const label = page.getByText(selectors.remember).first();
      if (
        await label.waitFor({ state: 'visible', timeout: 5_000 }).then(
          () => true,
          () => false,
        )
      ) {
        await this.pacing.click(label).catch(() => undefined);
      }
    }
    const inApp = await this.until(page, () => (this.onApp(page) ? true : undefined));
    return inApp ? { kind: 'ok' } : this.failure(page);
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
    const policies = await this.accountPolicies(page, w);
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
    const template = await this.documentTemplate(page);

    const url = new URL(template.url);
    url.pathname = url.pathname.replace(
      /\/policies\/[^/]+\/document/,
      `/policies/${encodeURIComponent(policy.number)}/document`,
    );
    url.searchParams.set('policyInfoKey', policy.key);
    const body = JSON.stringify({ ...template.body, mimeType: 'pdf' });

    let res: { status: number; json: unknown };
    try {
      res = await page.evaluate(
        async ({ u, h, b }) => {
          const r = await fetch(u, { method: 'POST', headers: h, body: b, credentials: 'include' });
          let json: unknown = null;
          try {
            json = await r.json();
          } catch {
            // not JSON: decided from the status
          }
          return { status: r.status, json };
        },
        { u: url.href, h: template.headers, b: body },
      );
    } catch {
      throw new AppError('CARRIER_UNAVAILABLE', 'document request');
    }
    if (res.status === 401) throw new AppError('SESSION_EXPIRED');
    if (res.status < 200 || res.status >= 300) {
      throw new AppError('CARRIER_UNAVAILABLE', `document ${res.status}`);
    }
    const first = (res.json as { documents?: unknown[] } | null)?.documents?.[0];
    if (typeof first !== 'string') throw new AppError('CARRIER_PAGE_CHANGED', 'document shape');
    const bytes = new Uint8Array(Buffer.from(first, 'base64'));
    if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
      throw new AppError('CARRIER_PAGE_CHANGED', 'document is not a PDF');
    }
    return { mimeType: 'application/pdf', filename: `progressive-${documentId}.pdf`, body: bytes };
  }

  /**
   * The account's policies: from the handshake the app makes on load. If it lists none we can
   * read, the app's own ID-card request names a policy too, so use that (one ID card rather than
   * none). Only when both fail is the page changed, and the error names the handshake's shape.
   */
  private async accountPolicies(page: Page, w: Watch): Promise<Policy[]> {
    const seen = await this.until(
      page,
      () => w.handshakePolicies ?? (w.handshakeShape !== undefined ? [] : undefined),
    );
    if (seen && seen.length > 0) return seen;
    try {
      const fromApp = policyFromDocumentUrl((await this.documentTemplate(page)).url);
      if (w.handshakePolicies) return w.handshakePolicies; // a later handshake listed them
      if (fromApp) return [fromApp];
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'CARRIER_PAGE_CHANGED') throw err;
    }
    if (seen === null) throw new AppError('CARRIER_UNAVAILABLE', 'account handshake');
    throw new AppError('CARRIER_PAGE_CHANGED', `handshake shape ${w.handshakeShape ?? '?'}`);
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
          w.template = { url: req.url(), headers, body: body as Record<string, unknown> };
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
    }
  }

  /** The app's own ID-card request. If it hasn't made one yet, open the ID cards page so it does. */
  private async documentTemplate(page: Page): Promise<Template> {
    const w = this.watch(page);
    if (w.template) return w.template;
    const link = page
      .getByRole('link', { name: selectors.idCards })
      .or(page.getByRole('button', { name: selectors.idCards }))
      .first();
    await step('ID cards link', () => link.click({ timeout: this.timeout }));
    const template = await this.until(page, () => w.template);
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
  ): Promise<T | null> {
    const deadline = Date.now() + this.timeout;
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
