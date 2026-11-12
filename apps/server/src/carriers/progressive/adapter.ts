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
  Signal,
  type StepLog,
  describeShape,
  evaluateInPage,
  inPageFailure,
  maskPolicyNumber,
  sortDocuments,
  step,
  waitUntil,
} from '../shared.js';
import { cardFile, cardFiles } from './document.js';
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
  /** How to ask for an ID card, if already known; otherwise learned from the first login. */
  cardRequest?: CardRequest;
  /** Learn it from the app's own request (default true). Off: always use the ID cards page. */
  learnCardRequest?: boolean;
}

/** The app's ID-card request, without anything of an account: `{n}` stands for the policy number. */
export interface CardRequest {
  path: string;
  body: Record<string, unknown>;
  /** The app's API key header(s). Not a user's secret, but never logged. */
  keys?: Record<string, string>;
}

const API_KEY = /^api[-_]?key$/i;

type ClickResult = 'clicked' | 'not needed' | 'failed';

/** Milliseconds since it was made. */
const timer = () => {
  const start = Date.now();
  return () => Date.now() - start;
};

/** Document IDs of a card's further images: "idcard-1-image2", "idcard-1-image3", ... */
const IMAGE = '-image';

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
  /** Fires whenever something below changes, or the page navigates: waits re-check then. */
  readonly changed = new Signal();
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
  /** Resolves when no handshake answer is being read. */
  reading: Promise<void> = Promise.resolve();
  /** The handshake answer, kept in memory to see where the card request's fields come from. */
  handshakeBody?: unknown;
  /** Requests we made ourselves ("url\nbody"): not the app's, so not watched as such. */
  ours = new Set<string>();
  /** Cards we asked for ourselves, by policy number (see ownCard). Memory only. */
  ownCards = new Map<string, unknown>();
}

// What our own API requests copy from the app's: its token, its API key (the real app sends
// `api_key`; without it our card request was refused with a 401) and its x-* headers. The
// browser adds the rest (origin, referer, sec-*) itself.
const KEEP_HEADER = /^(authorization|accept|content-type|api[-_]?key|x-[a-z0-9-]+)$/i;

/** Where `value` appears in `body`, as key paths ("policySessions[].term"): names only. */
function pathsOf(body: unknown, value: unknown): string[] {
  const found = new Set<string>();
  if (typeof value !== 'string' && typeof value !== 'number') return [];
  const visit = (v: unknown, path: string, depth: number): void => {
    if (depth > 8 || found.size >= 5) return;
    if (v === value) found.add(path || '(root)');
    else if (Array.isArray(v)) for (const x of v) visit(x, `${path}[]`, depth + 1);
    else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        visit(x, path ? `${path}.${/^[A-Za-z_]{1,40}$/.test(k) ? k : '#'}` : k, depth + 1);
      }
    }
  };
  visit(body, '', 0);
  return [...found];
}

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
  /** How the app asks for an ID card, once seen (see learnCardRequest). */
  private learned: CardRequest | undefined;
  private readonly learns: boolean;
  private readonly detector = new BlockDetector(blockRules);
  private readonly watches = new WeakMap<Page, Watch>();
  /** Document ID -> the policy it belongs to, per page. */
  private readonly policies = new WeakMap<Page, Map<string, Policy>>();
  /** The ID cards page being opened, per page: callers share one click-through. */
  private readonly opening = new WeakMap<Page, Promise<Template>>();

  constructor(options: ProgressiveAdapterOptions) {
    this.log = options.log ?? (() => undefined);
    this.learned = options.cardRequest;
    this.learns = options.learnCardRequest ?? true;
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
    const t = timer();
    const hadForm = await this.visible(page, selectors.username);
    if (!hadForm) await this.openLogin(page);
    const formMs = t();

    await step('login fields', async () => {
      await this.pacing.type(await this.field(page, selectors.username, 'username'), username);
      // Passwords are usually filled by a password manager, not typed.
      await this.pacing.autofill(await this.field(page, selectors.password, 'password'), password);
    });
    const typedMs = t();
    await step('sign-in button', () =>
      this.pacing.click(page.getByRole('button', { name: selectors.signIn }).first()),
    );
    const submittedMs = t();

    // Next: the SMS step, straight into the account (device remembered), or a rejection. Some
    // versions first ask how to send the code: choose text as soon as that button shows.
    const sendText = page.getByRole('button', { name: selectors.sendText }).first();
    let choseText = false;
    const next = await this.until(page, async () => {
      if (w.statuses.includes('OTP_REQUIRED')) return 'otp';
      if (this.onApp(page)) return 'in';
      if (w.credentialCheck !== undefined && w.credentialCheck >= 400) return 'rejected';
      if (!choseText && (await sendText.isVisible().catch(() => false))) {
        choseText = true;
        void this.pacing.click(sendText).catch(() => undefined);
      }
      return undefined;
    });
    this.log('progressive login', {
      prewarmedForm: hadForm,
      formMs,
      typedMs,
      submittedMs,
      choseText,
      answerMs: t(),
      result: next ?? 'no answer',
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
    // Opening the ID cards page makes the app fetch each card (as images). Start that now, while
    // the account's handshake (the policy list) is still coming: the two took 4.4 s and 5.5 s
    // one after the other. A failure here is reported by the await below.
    // Not when we already know how to ask for a card ourselves: then the page isn't needed.
    let cardsPage = this.learned ? undefined : this.documentTemplate(page);
    cardsPage?.catch(() => undefined);
    const policies = await this.accountPolicies(page, w);
    this.log('progressive policies', { count: policies.length, ms: t() });
    const map = new Map<string, Policy>();

    // The fast route: our own request for the first card, as a PDF, the moment the policy list
    // is here. One document per policy; the other cards are asked for when they are opened.
    const firstPolicy = policies[0];
    const firstCard = firstPolicy ? await this.ownCard(page, w, firstPolicy) : undefined;
    if (firstCard !== undefined) {
      const docs = policies.map((p, i): DocumentMeta => {
        const id = `idcard-${i + 1}`;
        map.set(id, p);
        const masked = maskPolicyNumber(p.number);
        return {
          id,
          title: 'ID card',
          kind: 'id_card',
          mimeType: i === 0 ? cardFile(firstCard).mimeType : 'application/pdf',
          ...(masked ? { policyNumberMasked: masked } : {}),
        };
      });
      this.policies.set(page, map);
      return sortDocuments(docs);
    }
    // Otherwise through the ID cards page, as the app does it.
    cardsPage ??= this.documentTemplate(page);
    // Each image is its own document, served as it came: no conversion. The list waits for the
    // cards so it knows how many there are; the first document needs the first card anyway.
    await cardsPage;
    // The page asks for the cards one after another: give it a moment to ask for every policy's,
    // or a card still on its way would be listed as a single document. No wait once all are asked.
    await this.until(
      page,
      () =>
        policies.every((p) => w.appAsked.some((a) => a.number === p.number)) ? true : undefined,
      500,
    );
    const docs: DocumentMeta[] = [];
    for (const [i, p] of policies.entries()) {
      const id = `idcard-${i + 1}`;
      map.set(id, p);
      const masked = maskPolicyNumber(p.number);
      const extra = masked ? { policyNumberMasked: masked } : {};
      // A card the app didn't fetch comes later from our own request, as one PDF.
      let types: string[] = ['application/pdf'];
      if (w.appAsked.some((a) => a.number === p.number)) {
        try {
          const files = await this.cardResponse(page, p);
          const n = cardFiles(files).length;
          if (n > 0) types = Array.from({ length: n }, (_, k) => cardFile(files, k).mimeType);
        } catch {
          types = ['application/pdf']; // listed anyway; fetching it reports the problem
        }
      }
      types.forEach((mimeType, k) => {
        docs.push({
          id: k === 0 ? id : `${id}${IMAGE}${k + 1}`,
          title: types.length > 1 ? `ID card (image ${k + 1} of ${types.length})` : 'ID card',
          kind: 'id_card',
          mimeType,
          ...extra,
        });
      });
    }
    this.policies.set(page, map);
    return sortDocuments(docs);
  }

  async fetchDocument(page: Page, documentId: string): Promise<DocumentContent> {
    const m = new RegExp(`^(idcard-\\d+)(?:${IMAGE}(\\d+))?$`).exec(documentId);
    if (!m?.[1]) throw new AppError('NOT_FOUND');
    const cardId = m[1];
    const index = m[2] ? Number(m[2]) - 1 : 0;
    if (!this.policies.get(page)?.has(cardId)) await this.listDocuments(page);
    const policy = this.policies.get(page)?.get(cardId);
    if (!policy) throw new AppError('NOT_FOUND');
    const file = cardFile(await this.cardResponse(page, policy), index);
    const suffix = index === 0 ? '' : `-${index + 1}`;
    return {
      mimeType: file.mimeType,
      filename: `progressive-${cardId}${suffix}.${file.extension}`,
      body: file.bytes,
    };
  }

  /**
   * The ID card's files (base64, as Progressive returns them) for a policy. First the card the
   * app itself fetched (opening the ID cards page makes it ask): proven to work on the real site,
   * and already here. Otherwise our own request, built from the app's.
   */
  private async cardResponse(page: Page, policy: Policy): Promise<unknown> {
    const w = this.watch(page);
    // Our own request, when we know how to make it and the page hasn't fetched this card itself.
    if (!w.appAsked.some((p) => p.number === policy.number)) {
      const mine = await this.ownCard(page, w, policy);
      if (mine !== undefined) return mine;
    }
    const t = timer();
    const template = await this.documentTemplate(page);
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
      return (own.json as { documents?: unknown } | undefined)?.documents;
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
    return (res.json as { documents?: unknown } | null)?.documents;
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
   * Remember how the app asks for an ID card, so later logins can ask themselves as soon as the
   * policy list arrives (a real login: 1.2 s, against ~6 s for the "ID cards" link plus the
   * page's own request). Kept only if nothing in it belongs to an account: every field must be a
   * boolean, a number, a short word, a few digits (dpi) or empty, and no string may appear in
   * the account's handshake. Shared by all logins of this process; memory only.
   */
  private learnCardRequest(
    w: Watch,
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): void {
    if (this.learned || !this.learns) return;
    const generic = (v: unknown): boolean =>
      v === null ||
      typeof v === 'boolean' ||
      typeof v === 'number' ||
      (typeof v === 'string' &&
        /^([A-Za-z_-]{1,24}|[0-9]{1,4})$/.test(v) &&
        pathsOf(w.handshakeBody, v).length === 0) ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
    const specific = Object.entries(body)
      .filter(([, v]) => !generic(v))
      .map(([k]) => k);
    const path = new URL(url).pathname.replace(
      /\/policies\/[^/]+\/document/,
      '/policies/{n}/document',
    );
    if (specific.length > 0 || !path.includes('{n}')) {
      this.log('progressive card request not learned', { fields: specific.sort().join(' ') });
      return;
    }
    // The app's API key goes with it: the gateway's key, the same for every visitor, and not
    // necessarily on the request our token is read from. Memory only, never logged.
    const keys = Object.fromEntries(Object.entries(headers).filter(([k]) => API_KEY.test(k)));
    this.learned = { path, body: { ...body }, keys };
    // Every value passed the check above: settings, no identifiers.
    this.log('progressive card request learned', { path, body: JSON.stringify(body) });
  }

  /**
   * Ask for a policy's ID card ourselves, as a PDF, with the request learned from the app and
   * this page's own token and API key. Undefined if we can't (nothing learned yet, no token, or
   * Progressive refuses): the caller then goes through the ID cards page as before.
   */
  private async ownCard(page: Page, w: Watch, policy: Policy): Promise<unknown> {
    const have = w.ownCards.get(policy.number);
    if (have !== undefined) return have;
    const learned = this.learned;
    if (!learned) return undefined;
    const headers = await this.until(page, () => w.apiHeaders, 2_000);
    if (!headers) return undefined;
    const t = timer();
    const url = new URL(
      learned.path.replace('{n}', encodeURIComponent(policy.number)),
      this.urls.api,
    );
    url.searchParams.set('policyInfoKey', policy.key);
    let status = 0;
    let files = 0;
    try {
      const res = await this.postDocument(
        page,
        url.href,
        { ...learned.keys, ...headers, 'content-type': 'application/json' },
        JSON.stringify({ ...learned.body, mimeType: 'pdf' }),
      );
      status = res.status;
      const documents = (res.json as { documents?: unknown } | null)?.documents;
      files = cardFiles(documents).length;
      if (status >= 200 && status < 300 && files > 0) {
        cardFile(documents); // a PDF or an image, or it throws
        w.ownCards.set(policy.number, documents);
        return documents;
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      this.log('progressive own card request', { status, files, ms: t() });
    }
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
    // Marked as ours, so the page watcher doesn't take it for the app's own request.
    this.watch(page).ours.add(`${url}\n${body}`);
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
    // Waits also look at the page's URL (on the account yet? the session-timeout page?).
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) created.changed.notify();
    });
    return w;
  }

  private async onRequest(w: Watch, req: Request): Promise<void> {
    if (!req.url().startsWith(this.urls.api)) return;
    const all = await req.allHeaders().catch(() => ({}) as Record<string, string>);
    const headers = Object.fromEntries(Object.entries(all).filter(([k]) => KEEP_HEADER.test(k)));
    if (headers.authorization) w.apiHeaders = headers;
    // The app's own ID-card request: the template for ours (its field values aren't documented).
    if (
      !w.ours.has(`${req.url()}\n${req.postData() ?? ''}`) &&
      req.method() === 'POST' &&
      /\/policies\/[^/]+\/document/.test(new URL(req.url()).pathname)
    ) {
      try {
        const body = JSON.parse(req.postData() ?? '') as unknown;
        if (body && typeof body === 'object' && (body as { type?: unknown }).type === 'idCard') {
          if (!w.template) {
            // Which headers the app sends, by name only: our own copy of this request was
            // refused (401), and it only carries the "kept" ones. Never the values.
            const names = Object.keys(all).sort();
            this.log('progressive card request headers', {
              kept: names.filter((k) => KEEP_HEADER.test(k)).join(' '),
              dropped: names.filter((k) => !KEEP_HEADER.test(k)).join(' '),
              bodyKeys: Object.keys(body).sort().join(' '),
            });
          }
          w.template ??= { url: req.url(), headers, body: body as Record<string, unknown> };
          this.learnCardRequest(w, req.url(), headers, body as Record<string, unknown>);
          const asked = policyFromDocumentUrl(req.url());
          if (asked && !w.appAsked.some((p) => p.number === asked.number)) w.appAsked.push(asked);
          w.changed.notify();
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
      w.changed.notify();
      const body = (await res.json().catch(() => undefined)) as { status?: unknown } | undefined;
      if (typeof body?.status === 'string' && /^[A-Z_]{3,40}$/.test(body.status)) {
        w.statuses.push(body.status);
        w.changed.notify();
      }
      return;
    }
    if (url.startsWith(this.urls.api) && new URL(url).pathname.endsWith('/handshake') && res.ok()) {
      // Remembered while it runs: a click that navigates must not cut this read short.
      const read = res.json().catch(() => 'not JSON' as unknown);
      const done = read.then(() => undefined);
      w.reading = w.reading.then(() => done);
      const body: unknown = await read;
      w.handshakeBody ??= body;
      const found = findPolicies(body);
      if (found.length > 0) w.handshakePolicies ??= found;
      else w.handshakeShape ??= describeShape(body);
      w.changed.notify();
      return;
    }
    // The app's own ID-card response (not ours: ours are made with fetch in the page too, but
    // only after appCards is read, and a later one never replaces the app's).
    const card = policyFromDocumentUrl(url);
    if (w.ours.has(`${url}\n${res.request().postData() ?? ''}`)) return;
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
      w.changed.notify();
    }
  }

  /** The app's own ID-card request. If it hasn't made one yet, open the ID cards page so it does. */
  private documentTemplate(page: Page): Promise<Template> {
    const w = this.watch(page);
    if (w.template) return Promise.resolve(w.template);
    let opening = this.opening.get(page);
    if (!opening) {
      opening = this.openIdCards(page, w).finally(() => this.opening.delete(page));
      this.opening.set(page, opening);
    }
    return opening;
  }

  private async openIdCards(page: Page, w: Watch): Promise<Template> {
    const link = page
      .getByRole('link', { name: selectors.idCards })
      .or(page.getByRole('button', { name: selectors.idCards }))
      .first();
    const t = timer();
    // When the link shows, a handshake answer may be arriving at the same moment (the app renders
    // its navigation on it). Finish reading it before the click: a navigation can discard the
    // body, and with it the account's full policy list. Not waited for if it hasn't answered yet.
    await Promise.race([
      link.waitFor({ state: 'visible', timeout: this.timeout }).catch(() => undefined),
      this.until(page, () => (w.template ? true : undefined)),
    ]);
    await w.reading;
    const clicked = await this.clickUnless(
      page,
      link,
      () => w.template !== undefined,
      this.timeout,
    );
    const clickMs = t();
    const template = await this.until(page, () => w.template);
    this.log('progressive id cards page', {
      clicked,
      clickMs,
      requestMs: t(),
      found: !!template,
    });
    if (!template && clicked === 'failed')
      throw new AppError('CARRIER_PAGE_CHANGED', 'ID cards link');
    if (!template) throw new AppError('CARRIER_PAGE_CHANGED', 'no ID card request from the app');
    return template;
  }

  // ---------- helpers ----------

  private onSessionTimeout(page: Page): boolean {
    try {
      return selectors.sessionTimeoutPath.test(new URL(page.url()).pathname);
    } catch {
      return false;
    }
  }

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

  /**
   * Waits until `check` returns a value; null on timeout. It re-checks the moment the page's own
   * traffic or URL changes (see Watch), and every 200 ms for what nothing signals (an element
   * showing). Stops at once on Progressive's session-timeout page: nothing we wait for comes
   * after it (it cost 90 s of timeouts once).
   */
  private async until<T>(
    page: Page,
    check: () => T | undefined | Promise<T | undefined>,
    timeoutMs = this.timeout,
  ): Promise<T | null> {
    return waitUntil(
      () => {
        if (this.onSessionTimeout(page)) {
          throw new AppError('SESSION_EXPIRED', 'progressive session-timeout page');
        }
        return check();
      },
      {
        signal: this.watch(page).changed,
        tick: () => page.waitForTimeout(200),
        timeoutMs,
      },
    );
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
