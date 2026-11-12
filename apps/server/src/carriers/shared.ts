import { isBrowserGone } from '../browser/errors.js';
import type { DocumentKind, DocumentMeta } from '@carrier-docs/contracts';
import type { Page } from 'patchright';
import { AppError } from '../core/errors.js';

/** Helpers every carrier adapter uses. Nothing here is carrier-specific. */

const KIND_ORDER: Record<DocumentKind, number> = {
  id_card: 0,
  declarations: 1,
  policy: 2,
  other: 3,
};

/** ID cards first (the headline latency number), then declarations, then the rest. Stable. */
export function sortDocuments(docs: DocumentMeta[]): DocumentMeta[] {
  return docs
    .map((d, i) => ({ d, i }))
    .sort((a, b) => KIND_ORDER[a.d.kind] - KIND_ORDER[b.d.kind] || a.i - b.i)
    .map(({ d }) => d);
}

/** "DEMO-0000-1234" -> "••••1234". The full number never leaves the adapter. */
export function maskPolicyNumber(policyNumber: string): string | undefined {
  const tail = policyNumber.replace(/[^A-Za-z0-9]/g, '').slice(-4);
  return tail.length === 4 ? `••••${tail}` : undefined;
}

export interface InPageResponse<T> {
  status: number;
  body: T;
}

/**
 * GET a JSON URL from inside the logged-in page with the browser's own fetch (design D1-B): the
 * request carries the page's cookies and the real browser's TLS fingerprint.
 */
export async function fetchJsonInPage<T>(page: Page, url: string): Promise<InPageResponse<T>> {
  try {
    return await page.evaluate(async (u) => {
      const res = await fetch(u, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON (an error page, a login redirect): the caller decides from the status.
      }
      return { status: res.status, body: body as T };
    }, url);
  } catch {
    throw new AppError('CARRIER_UNAVAILABLE', 'in-page fetch failed');
  }
}

export interface InPageFile {
  status: number;
  contentType: string;
  contentDisposition: string;
  bytes: Uint8Array;
}

/**
 * GET a file from inside the page. The bytes cross from the page as base64, the one encoding
 * page.evaluate can return losslessly. Never logged: it's a user's document.
 */
export async function fetchFileInPage(page: Page, url: string): Promise<InPageFile> {
  let result: { status: number; contentType: string; contentDisposition: string; b64: string };
  try {
    result = await page.evaluate(async (u) => {
      const res = await fetch(u, { credentials: 'include' });
      const buf = new Uint8Array(await res.arrayBuffer());
      let binary = '';
      for (let i = 0; i < buf.length; i += 0x8000) {
        binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      }
      return {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        contentDisposition: res.headers.get('content-disposition') ?? '',
        b64: btoa(binary),
      };
    }, url);
  } catch {
    throw new AppError('CARRIER_UNAVAILABLE', 'in-page download failed');
  }
  return {
    status: result.status,
    contentType: result.contentType,
    contentDisposition: result.contentDisposition,
    bytes: new Uint8Array(Buffer.from(result.b64, 'base64')),
  };
}

/** The filename from a Content-Disposition header, if it names one. */
export function filenameFrom(contentDisposition: string): string | undefined {
  return /filename="?([^";]+)"?/i.exec(contentDisposition)?.[1];
}

/** Run a page step; a missing element or a timeout means the portal changed under us. */
export async function step<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    // A crashed or closed browser is not a changed page: retryable.
    if (isBrowserGone(err)) throw new AppError('CARRIER_UNAVAILABLE', what);
    throw new AppError('CARRIER_PAGE_CHANGED', what);
  }
}
