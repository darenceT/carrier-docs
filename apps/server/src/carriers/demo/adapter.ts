import type { CarrierInfo, DocumentKind, DocumentMeta } from '@carrier-docs/contracts';
import type { Page, Response } from 'patchright';
import { z } from 'zod';
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
import {
  fetchFileInPage,
  fetchJsonInPage,
  filenameFrom,
  maskPolicyNumber,
  sortDocuments,
  step,
} from '../shared.js';
import { blockRules, paths, selectors } from './selectors.js';

export const DEMO_CARRIER: CarrierInfo = {
  id: 'demo',
  name: 'Demo carrier (test fixture)',
  isDemo: true,
  loginFields: ['username', 'password'],
};

export interface DemoAdapterOptions {
  /** Where the mock portal is served, e.g. "http://127.0.0.1:3000/demo-portal". */
  baseUrl: string;
  pacing: Pacing;
}

/** The mock portal's document list, validated: a shape change is CARRIER_PAGE_CHANGED. */
const documentList = z.object({
  documents: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string(),
      kind: z.string(),
      policyNumber: z.string(),
      url: z.string().min(1),
    }),
  ),
});

const KINDS: ReadonlySet<string> = new Set<DocumentKind>(['id_card', 'declarations', 'policy']);

/**
 * A normal CarrierAdapter against the mock portal, driven through the real browser and anti-bot
 * layer, so the whole flow is exercised before any real carrier code exists.
 */
export class DemoAdapter implements CarrierAdapter<Page> {
  readonly info = DEMO_CARRIER;
  private readonly base: URL;
  private readonly pacing: Pacing;
  private readonly detector = new BlockDetector(blockRules);
  /** Download URLs from the last listing, per page (the adapter is shared by every session). */
  private readonly downloads = new WeakMap<Page, Map<string, string>>();

  constructor(options: DemoAdapterOptions) {
    this.base = new URL(options.baseUrl.replace(/\/+$/, '') + '/');
    this.pacing = options.pacing;
  }

  async openLogin(page: Page): Promise<void> {
    await this.goto(page, paths.login);
    await step('login form', () => page.locator(selectors.login.form).waitFor());
  }

  async login(page: Page, credentials: Credentials): Promise<LoginOutcome> {
    const { username, password } = credentials;
    if (!username || !password) throw new AppError('VALIDATION_FAILED', 'username and password');
    if (!this.isAt(page, paths.login)) await this.openLogin(page);

    await step('login fields', async () => {
      await this.pacing.type(page.locator(selectors.login.username), username);
      await this.pacing.type(page.locator(selectors.login.password), password);
    });
    const response = await this.submit(page, selectors.login.submit, paths.login);

    if (this.isAt(page, paths.mfa)) return this.mfaRequired(page, false);
    if (this.isAt(page, paths.dashboard)) return { kind: 'ok' };
    return this.failure(page, response);
  }

  async submitMfa(page: Page, code: string): Promise<LoginOutcome> {
    if (!this.isAt(page, paths.mfa)) throw new AppError('CARRIER_PAGE_CHANGED', 'not on MFA page');
    await step('MFA fields', async () => {
      await this.pacing.type(page.locator(selectors.mfa.code), code);
      await page.locator(selectors.mfa.remember).check();
    });
    const response = await this.submit(page, selectors.mfa.submit, paths.mfa);

    if (this.isAt(page, paths.dashboard)) return { kind: 'ok' };
    if (await page.locator(selectors.mfa.lockout).count()) {
      return { kind: 'failed', code: 'MFA_INVALID' };
    }
    if (this.isAt(page, paths.mfa) && (await page.locator(selectors.error).count())) {
      return this.mfaRequired(page, true);
    }
    return this.failure(page, response);
  }

  async isSessionValid(page: Page): Promise<boolean> {
    await this.goto(page, paths.dashboard);
    return (
      this.isAt(page, paths.dashboard) &&
      (await page.locator(selectors.dashboard.policies).count()) > 0
    );
  }

  async listDocuments(page: Page): Promise<DocumentMeta[]> {
    const res = await fetchJsonInPage<unknown>(page, this.url(paths.documentsApi));
    if (res.status === 401) throw new AppError('SESSION_EXPIRED');
    if (res.status !== 200) throw new AppError('CARRIER_UNAVAILABLE', `documents ${res.status}`);
    const parsed = documentList.safeParse(res.body);
    if (!parsed.success) throw new AppError('CARRIER_PAGE_CHANGED', 'document list shape');

    const urls = new Map<string, string>();
    const docs = parsed.data.documents.map((d): DocumentMeta => {
      urls.set(d.id, new URL(d.url, this.base).href);
      const meta: DocumentMeta = {
        id: d.id,
        title: d.title,
        kind: KINDS.has(d.kind) ? (d.kind as DocumentKind) : 'other',
        mimeType: 'application/pdf',
      };
      const masked = maskPolicyNumber(d.policyNumber);
      if (masked) meta.policyNumberMasked = masked;
      return meta;
    });
    this.downloads.set(page, urls);
    return sortDocuments(docs);
  }

  async fetchDocument(page: Page, documentId: string): Promise<DocumentContent> {
    // A page reopened from a saved session hasn't listed yet: list first to learn the URLs.
    if (!this.downloads.get(page)?.has(documentId)) await this.listDocuments(page);
    const url = this.downloads.get(page)?.get(documentId);
    if (!url) throw new AppError('NOT_FOUND');

    const file = await fetchFileInPage(page, url);
    if (file.status === 401) throw new AppError('SESSION_EXPIRED');
    if (file.status === 404) throw new AppError('NOT_FOUND');
    if (file.status !== 200) throw new AppError('CARRIER_UNAVAILABLE', `document ${file.status}`);
    return {
      mimeType: file.contentType.split(';')[0]?.trim() || 'application/pdf',
      filename: filenameFrom(file.contentDisposition) ?? `${documentId}.pdf`,
      body: file.bytes,
    };
  }

  // ---------- helpers ----------

  private url(path: string): string {
    return new URL(path.replace(/^\//, ''), this.base).href;
  }

  private isAt(page: Page, path: string): boolean {
    return new URL(page.url()).pathname === new URL(this.url(path)).pathname;
  }

  private async goto(page: Page, path: string): Promise<void> {
    try {
      await page.goto(this.url(path), { waitUntil: 'domcontentloaded' });
    } catch {
      throw new AppError('CARRIER_UNAVAILABLE', `could not load ${path}`);
    }
  }

  /** Click a form's submit button and wait for its POST and the page it leads to. */
  private async submit(page: Page, button: string, path: string): Promise<Response> {
    const target = new URL(this.url(path)).pathname;
    return step(`submit ${path}`, async () => {
      const posted = page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === target,
      );
      await this.pacing.click(page.locator(button));
      const response = await posted;
      await page.waitForLoadState('domcontentloaded');
      return response;
    });
  }

  private async mfaRequired(page: Page, rejected: boolean): Promise<LoginOutcome> {
    const hint = (
      await page
        .locator(selectors.mfa.hint)
        .textContent()
        .catch(() => null)
    )?.trim();
    return { kind: 'mfa_required', rejected, ...(hint ? { hint } : {}) };
  }

  /** Not where a successful step lands: ask the BlockDetector why. */
  private async failure(page: Page, response: Response): Promise<LoginOutcome> {
    const verdict = this.detector.classify(await snapshotPage(page, response.status()));
    return {
      kind: 'failed',
      code: verdictToErrorCode(verdict === 'ok' ? 'page_changed' : verdict),
    };
  }
}
