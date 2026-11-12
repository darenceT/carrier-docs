/**
 * The contract every CarrierAdapter must keep, as one reusable suite. Each carrier's browser test
 * calls `carrierContract()` with its adapter (pointed at a local portal) and working test
 * credentials; a new carrier gets these checks by adding one call.
 *
 * It asserts only what the SessionManager and the UI rely on, never carrier specifics:
 * login outcomes, MFA retry, ID cards first, masked policy numbers, real PDFs, saved-session
 * checks, and stable error codes.
 */
import type { Browser as TestBrowser } from '@playwright/test';
import type { DocumentKind, DocumentMeta } from '@carrier-docs/contracts';
import type { BrowserContext, Page } from 'patchright';
import { afterEach, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../src/core/errors.js';
import type { CarrierAdapter, Credentials } from '../../src/core/ports.js';

export interface ContractHarness {
  adapter: CarrierAdapter<Page>;
  browser: TestBrowser;
  /** Credentials the local portal accepts. A function, so each login can use a fresh account. */
  valid: () => Credentials;
  /** The MFA code the portal accepts; omit for a carrier (or account) without MFA. */
  mfaCode?: string;
  /** Credentials the portal rejects as wrong. */
  wrong?: Credentials;
}

const KIND_ORDER: DocumentKind[] = ['id_card', 'declarations', 'policy', 'other'];
const WRONG_CODE = '000000';

async function bytes(body: Uint8Array | AsyncIterable<Uint8Array>): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Registers the suite. `harness` is read inside each test, after the caller's beforeAll ran. */
export function carrierContract(harness: () => ContractHarness): void {
  describe('CarrierAdapter contract', () => {
    const contexts: BrowserContext[] = [];

    const newContext = async (storageState?: unknown): Promise<BrowserContext> => {
      const options = storageState ? { storageState: storageState as never } : {};
      const context = (await harness().browser.newContext(options)) as unknown as BrowserContext;
      contexts.push(context);
      return context;
    };
    const newPage = async (storageState?: unknown): Promise<Page> =>
      (await newContext(storageState)).newPage();

    afterEach(async () => {
      await Promise.allSettled(contexts.splice(0).map((c) => c.close()));
    });

    /** A full login, the way the SessionManager drives it. */
    const logIn = async (page: Page): Promise<void> => {
      const { adapter, valid, mfaCode } = harness();
      let outcome = await adapter.login(page, valid());
      if (outcome.kind === 'mfa_required') {
        expect(mfaCode, 'the portal asked for a code but the harness has none').toBeDefined();
        outcome = await adapter.submitMfa(page, mfaCode!);
      }
      expect(outcome).toEqual({ kind: 'ok' });
    };

    it('describes itself: an ID, a name, and the login fields it needs', () => {
      const { adapter, valid } = harness();
      expect(adapter.info.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(adapter.info.name.length).toBeGreaterThan(0);
      expect(adapter.info.loginFields.length).toBeGreaterThan(0);
      expect([...adapter.info.loginFields].sort()).toEqual(Object.keys(valid()).sort());
    });

    it('logs in from a blank page (no pre-warm) and from a pre-warmed login page', async () => {
      const { adapter } = harness();
      await logIn(await newPage());
      const prewarmed = await newPage();
      await adapter.openLogin(prewarmed);
      await logIn(prewarmed);
    });

    it('asks for a code, rejects a wrong one without ending the login, then accepts the right one', async (ctx) => {
      const { adapter, valid, mfaCode } = harness();
      if (mfaCode === undefined) return ctx.skip();
      const page = await newPage();
      const first = await adapter.login(page, valid());
      expect(first.kind).toBe('mfa_required');
      expect(first).not.toHaveProperty('rejected', true);
      expect(await adapter.submitMfa(page, WRONG_CODE)).toMatchObject({
        kind: 'mfa_required',
        rejected: true,
      });
      expect(await adapter.submitMfa(page, mfaCode)).toEqual({ kind: 'ok' });
    });

    it('reports wrong credentials as BAD_CREDENTIALS, as an outcome rather than a throw', async (ctx) => {
      const { adapter, wrong } = harness();
      if (!wrong) return ctx.skip();
      expect(await adapter.login(await newPage(), wrong)).toEqual({
        kind: 'failed',
        code: 'BAD_CREDENTIALS',
      });
    });

    it('lists documents ID cards first, with unique IDs and only masked policy numbers', async () => {
      const { adapter } = harness();
      const page = await newPage();
      await logIn(page);
      const docs: DocumentMeta[] = await adapter.listDocuments(page);
      expect(docs.length).toBeGreaterThan(0);
      expect(new Set(docs.map((d) => d.id)).size).toBe(docs.length);
      const ranks = docs.map((d) => KIND_ORDER.indexOf(d.kind));
      expect(ranks).not.toContain(-1);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      for (const d of docs) {
        expect(d.id.length).toBeGreaterThan(0);
        expect(d.title.length).toBeGreaterThan(0);
        expect(d.mimeType).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
        if (d.policyNumberMasked !== undefined) expect(d.policyNumberMasked).toMatch(/^••••.{4}$/);
        // IDs and titles reach the browser and the logs: no URLs or tokens in them.
        expect(`${d.id} ${d.title}`).not.toMatch(/https?:\/\//);
      }
    });

    it('fetches every listed document as real bytes with a safe filename', async () => {
      const { adapter } = harness();
      const page = await newPage();
      await logIn(page);
      for (const doc of await adapter.listDocuments(page)) {
        const file = await adapter.fetchDocument(page, doc.id);
        expect(file.mimeType).toBe(doc.mimeType);
        expect(file.filename).toMatch(/^[\w.() -]+$/);
        const body = await bytes(file.body);
        expect(body.length).toBeGreaterThan(0);
        if (file.mimeType === 'application/pdf') {
          expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        }
      }
    });

    it('fails with a stable error code for a document that was never listed', async () => {
      const { adapter } = harness();
      const page = await newPage();
      await logIn(page);
      await adapter.listDocuments(page);
      const err: unknown = await adapter.fetchDocument(page, 'no-such-document').catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(ERROR_CODES).toContain((err as { code?: string }).code);
    });

    it('accepts a saved session in a new context and serves documents from it', async () => {
      const { adapter } = harness();
      const context = await newContext();
      const page = await context.newPage();
      await logIn(page);
      const saved = await context.storageState();

      const restored = await newPage(saved);
      expect(await adapter.isSessionValid(restored)).toBe(true);
      const docs = await adapter.listDocuments(restored);
      expect(docs.length).toBeGreaterThan(0);
      const file = await adapter.fetchDocument(restored, docs[0]!.id);
      expect((await bytes(file.body)).length).toBeGreaterThan(0);
    });

    it('says a context with no saved session is not logged in, without throwing', async () => {
      expect(await harness().adapter.isSessionValid(await newPage())).toBe(false);
    });
  });
}
