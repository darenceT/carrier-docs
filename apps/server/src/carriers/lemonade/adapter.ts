import type { CarrierInfo, DocumentMeta } from '@carrier-docs/contracts';
import type { Locator, Page, Response } from 'patchright';
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
import { fetchJsonInPage, filenameFrom, step } from '../shared.js';
import { parsePolicies } from './policies.js';
import { LEMONADE_URLS, blockRules, selectors, type LemonadeUrls } from './selectors.js';

export const LEMONADE_CARRIER: CarrierInfo = {
  id: 'lemonade',
  name: 'Lemonade (renters)',
  isDemo: false,
  loginFields: ['email'],
};

export interface LemonadeAdapterOptions {
  pacing: Pacing;
  /** Override the real URLs; tests point these at a local imitation of the flow. */
  urls?: Partial<LemonadeUrls>;
  /** Timeout for one carrier step (a page load, a login call). Default 30 s. */
  stepTimeoutMs?: number;
}

/** Lemonade texts the code to the phone on the account; it isn't ours to show. */
const MFA_HINT = 'Lemonade texted a code to the phone on the account.';

/**
 * Lemonade (renters): email, then an SMS code; no "remember this device" step, so repeat runs
 * rely on the saved cookies. Documents come from one API call whose items carry cookie-free PDF
 * links (design D1, docs/spike.md).
 */
export class LemonadeAdapter implements CarrierAdapter<Page> {
  readonly info = LEMONADE_CARRIER;
  private readonly urls: LemonadeUrls;
  private readonly pacing: Pacing;
  private readonly timeout: number;
  private readonly detector = new BlockDetector(blockRules);
  /** PDF links from the last listing, per page (the adapter is shared by every session). */
  private readonly links = new WeakMap<Page, Map<string, string>>();

  constructor(options: LemonadeAdapterOptions) {
    this.urls = { ...LEMONADE_URLS, ...options.urls };
    this.pacing = options.pacing;
    this.timeout = options.stepTimeoutMs ?? 30_000;
  }

  async openLogin(page: Page): Promise<void> {
    await this.goto(page, this.urls.login);
    await this.firstVisible(page, selectors.email, 'email field');
  }

  async login(page: Page, credentials: Credentials): Promise<LoginOutcome> {
    const { email } = credentials;
    if (!email) throw new AppError('VALIDATION_FAILED', 'email');
    if (!this.onLoginPage(page)) await this.openLogin(page);

    const field = await this.firstVisible(page, selectors.email, 'email field');
    await step('email field', () => this.pacing.type(field, email));
    const presign = await this.awaitCall(page, this.urls.presign, () => field.press('Enter'));
    if (!presign) return this.failure(page);

    const status = presign.status();
    if (status >= 200 && status < 300) return { kind: 'mfa_required', hint: MFA_HINT };
    if (status === 403 || status === 429) return this.failure(page, status);
    if (status >= 500) return { kind: 'failed', code: 'CARRIER_UNAVAILABLE' };
    return { kind: 'failed', code: 'BAD_CREDENTIALS' };
  }

  async submitMfa(page: Page, code: string): Promise<LoginOutcome> {
    const field = await this.firstVisible(page, selectors.code, 'code field');
    // Typed key by key: also works for one-box-per-digit inputs that move focus as you type.
    // Many code forms submit on the last digit; the Enter press below covers those that don't.
    const signin = await this.awaitCall(page, this.urls.signin, async () => {
      await step('code field', () => this.pacing.type(field, code));
      await page.waitForTimeout(300);
      if (!(await this.signinStarted(page))) await field.press('Enter').catch(() => undefined);
    });
    if (!signin) return this.failure(page);

    const status = signin.status();
    if (status >= 200 && status < 300) return { kind: 'ok' };
    if (status === 403 || status === 429) return this.failure(page, status);
    if (status >= 500) return { kind: 'failed', code: 'CARRIER_UNAVAILABLE' };
    // Wrong or expired code: ask again; the session layer counts attempts.
    return { kind: 'mfa_required', hint: MFA_HINT, rejected: true };
  }

  async isSessionValid(page: Page): Promise<boolean> {
    await this.goto(page, this.urls.appHome);
    if (!this.onApp(page)) return false; // redirected to the login page
    try {
      await this.loadPolicies(page);
      return true;
    } catch (err) {
      if (err instanceof AppError && err.code === 'SESSION_EXPIRED') return false;
      throw err;
    }
  }

  async listDocuments(page: Page): Promise<DocumentMeta[]> {
    const { documents, links } = parsePolicies(await this.loadPolicies(page));
    this.links.set(page, links);
    return documents;
  }

  async fetchDocument(page: Page, documentId: string): Promise<DocumentContent> {
    if (!this.links.get(page)?.has(documentId)) await this.listDocuments(page);
    let file = await this.download(page, documentId);
    // The links rotate on every page load and may expire: re-list once for a fresh one.
    if (file === 'expired') {
      await this.listDocuments(page);
      file = await this.download(page, documentId);
    }
    if (file === 'expired') throw new AppError('SESSION_EXPIRED', 'document link expired');
    return file;
  }

  // ---------- documents ----------

  /**
   * The policies JSON. Once on the web app, two sources race: our own call to the API, and the
   * call the web app makes by itself when it loads. Ours usually wins, which skips waiting for
   * the dashboard (5.8 s in the spike); the app's is the fallback if ours is refused (for
   * example for a missing CSRF header).
   */
  private async loadPolicies(page: Page): Promise<unknown> {
    const isPolicies = (r: Response) => r.url().startsWith(this.urls.policiesApi);
    const readApp = async (r: Response): Promise<unknown> => {
      if (r.status() === 401) throw new AppError('SESSION_EXPIRED');
      if (!r.ok()) throw new Error(`policies ${r.status()}`);
      return (await r.json()) as unknown;
    };
    /** Loads the web app and takes the policies call it makes by itself. */
    const fromAppLoad = async (): Promise<unknown> => {
      const call = page.waitForResponse(isPolicies, { timeout: this.timeout });
      await this.goto(page, this.urls.appHome);
      if (!this.onApp(page)) {
        call.catch(() => undefined);
        throw new AppError('SESSION_EXPIRED', 'redirected to login');
      }
      return readApp(await call);
    };

    if (!this.onApp(page)) return fromAppLoad();

    // Already on the app (right after sign-in): our call, or the app's own if it is still coming.
    const appCall = page.waitForResponse(isPolicies, { timeout: this.timeout }).then(readApp);
    const ours = fetchJsonInPage<unknown>(page, this.urls.policiesApi).then((r) => {
      if (r.status === 401) throw new AppError('SESSION_EXPIRED');
      if (r.status !== 200) throw new Error(`policies ${r.status}`);
      return r.body;
    });
    try {
      return await Promise.any([
        // If ours is refused (e.g. a CSRF header we don't send), reload so the app calls again.
        ours.catch((err: unknown) => {
          if (err instanceof AppError) throw err;
          return fromAppLoad();
        }),
        appCall,
      ]);
    } catch (err) {
      const reasons = err instanceof AggregateError ? err.errors : [err];
      const expired = reasons.find((e) => e instanceof AppError && e.code === 'SESSION_EXPIRED');
      throw expired ?? new AppError('CARRIER_UNAVAILABLE', 'policies API');
    } finally {
      appCall.catch(() => undefined);
    }
  }

  /** Downloads one PDF. The link needs no cookies, so the context's request client is enough. */
  private async download(page: Page, documentId: string): Promise<DocumentContent | 'expired'> {
    const link = this.links.get(page)?.get(documentId);
    if (!link) throw new AppError('NOT_FOUND');
    let res;
    try {
      res = await page.context().request.get(link, { timeout: this.timeout });
    } catch {
      throw new AppError('CARRIER_UNAVAILABLE', 'document download');
    }
    if ([401, 403, 404, 410].includes(res.status())) return 'expired';
    if (!res.ok()) throw new AppError('CARRIER_UNAVAILABLE', `document ${res.status()}`);
    const bytes = new Uint8Array(await res.body());
    if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
      throw new AppError('CARRIER_PAGE_CHANGED', 'document is not a PDF');
    }
    const headers = res.headers();
    return {
      mimeType: 'application/pdf',
      filename: filenameFrom(headers['content-disposition'] ?? '') ?? `lemonade-${documentId}.pdf`,
      body: bytes,
    };
  }

  // ---------- helpers ----------

  private onLoginPage(page: Page): boolean {
    return this.sameOriginPath(page.url(), this.urls.login);
  }

  private onApp(page: Page): boolean {
    try {
      return new URL(page.url()).origin === new URL(this.urls.appHome).origin;
    } catch {
      return false;
    }
  }

  private sameOriginPath(a: string, b: string): boolean {
    try {
      const x = new URL(a);
      const y = new URL(b);
      return x.origin === y.origin && x.pathname === y.pathname;
    } catch {
      return false;
    }
  }

  private async goto(page: Page, url: string): Promise<void> {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
    } catch {
      throw new AppError('CARRIER_UNAVAILABLE', `could not load ${new URL(url).pathname}`);
    }
  }

  private async firstVisible(page: Page, css: readonly string[], what: string): Promise<Locator> {
    const any = page.locator(css.join(', ')).first();
    await step(what, () => any.waitFor({ state: 'visible', timeout: this.timeout }));
    return any;
  }

  private signinCalls = new WeakMap<Page, boolean>();

  private async signinStarted(page: Page): Promise<boolean> {
    return this.signinCalls.get(page) ?? false;
  }

  /**
   * Runs `action` and waits for the response to the call starting with `prefix`. Null on timeout
   * (the caller then asks the BlockDetector why). Records whether the sign-in call has started,
   * so submitMfa doesn't press Enter on a form that already submitted itself.
   */
  private async awaitCall(
    page: Page,
    prefix: string,
    action: () => Promise<unknown>,
  ): Promise<Response | null> {
    const isCall = (r: Response) => r.url().startsWith(prefix);
    const onRequest = (req: { url(): string }) => {
      if (prefix === this.urls.signin && req.url().startsWith(prefix)) {
        this.signinCalls.set(page, true);
      }
    };
    page.on('request', onRequest);
    try {
      const response = page.waitForResponse(isCall, { timeout: this.timeout });
      await action();
      return await response.catch(() => null);
    } finally {
      page.off('request', onRequest);
      this.signinCalls.delete(page);
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
