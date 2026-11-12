import { isBrowserGone } from '../browser/errors.js';
import type { DocumentKind, DocumentMeta } from '@carrier-docs/contracts';
import type { Page } from 'patchright';
import { AppError } from '../core/errors.js';

/** Helpers every carrier adapter uses. Nothing here is carrier-specific. */

/**
 * Where an adapter reports sub-step timings, for the latency work: step names, milliseconds and
 * outcomes only. Never credentials, codes, cookies, tokens, URLs with keys or document contents.
 */
export type StepLog = (msg: string, fields: Record<string, number | string | boolean>) => void;

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

/**
 * A response's shape for the logs, never its values: `{data:{items:{#:{id:n,form_url:null}}}}`.
 * Types: s string, n number, b boolean, null; arrays show their first element as `[...]`. Keys
 * that could be data (digits, or long) print as `#`, since some APIs key objects by policy ID.
 */
export function describeShape(value: unknown, depth = 4): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return depth > 0 ? `[${describeShape(value[0], depth - 1)}]` : '[…]';
  }
  if (typeof value === 'object') {
    if (depth === 0) return '{…}';
    const entries = Object.entries(value as Record<string, unknown>);
    const shown = entries
      .slice(0, 8)
      .map(([k, v]) => `${/^[A-Za-z_]{1,40}$/.test(k) ? k : '#'}:${describeShape(v, depth - 1)}`);
    if (entries.length > 8) shown.push('…');
    return `{${shown.join(',')}}`;
  }
  if (typeof value === 'string') return 's';
  if (typeof value === 'number') return 'n';
  if (typeof value === 'boolean') return 'b';
  return typeof value;
}

/** A string or number ID as a non-empty string, else undefined. */
export function idString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

/**
 * Why a call into the page failed, in a few words for the log (never the error's own message,
 * which can quote URLs). "navigated": the page moved while the call ran. "fetch rejected": the
 * browser's fetch threw (network, or CORS refused it).
 */
export function inPageFailure(err: unknown): string {
  if (isBrowserGone(err)) return 'browser gone';
  const m = err instanceof Error ? err.message : '';
  if (
    /execution context was destroyed|navigat|frame was detached|context.*(closed|destroyed)/i.test(
      m,
    )
  ) {
    return 'navigated';
  }
  if (/failed to fetch|networkerror|load failed|typeerror/i.test(m)) return 'fetch rejected';
  return 'other';
}

/**
 * page.evaluate, retried once if the page navigated mid-call (after it settles). Any other
 * failure is rethrown as is; callers name it with inPageFailure.
 */
export async function evaluateInPage<A, R>(
  page: Page,
  fn: (arg: A) => Promise<R>,
  arg: A,
): Promise<R> {
  // Arguments here are plain JSON (strings, records), so playwright's Unboxed<A> is A itself.
  const evaluate = page.evaluate.bind(page) as (f: (a: A) => Promise<R>, a: A) => Promise<R>;
  try {
    return await evaluate(fn, arg);
  } catch (err) {
    if (inPageFailure(err) !== 'navigated') throw err;
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    return await evaluate(fn, arg);
  }
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
    return await evaluateInPage(
      page,
      async (u: string) => {
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
      },
      url,
    );
  } catch (err) {
    throw new AppError('CARRIER_UNAVAILABLE', `in-page fetch failed: ${inPageFailure(err)}`);
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
    result = await evaluateInPage(
      page,
      async (u: string) => {
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
      },
      url,
    );
  } catch (err) {
    throw new AppError('CARRIER_UNAVAILABLE', `in-page download failed: ${inPageFailure(err)}`);
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

/**
 * Wakes waiters when something they watch changes (a response the adapter was waiting for
 * arrived, the page navigated), so a wait ends then and not at its next poll.
 */
export class Signal {
  private waiters = new Set<() => void>();

  notify(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  /** A promise for the next notify(), and a way to stop waiting for it. */
  next(): { promise: Promise<void>; cancel: () => void } {
    let wake!: () => void;
    const promise = new Promise<void>((resolve) => (wake = resolve));
    this.waiters.add(wake);
    return { promise, cancel: () => this.waiters.delete(wake) };
  }
}

export interface WaitUntilOptions {
  /** Re-check as soon as this fires. */
  signal: Signal;
  /** Re-check when this resolves too (for conditions nothing signals, e.g. an element showing). */
  tick: () => Promise<unknown>;
  timeoutMs: number;
  now?: () => number;
}

/**
 * Waits until `check` returns a value; null on timeout. It re-checks on every signal and every
 * tick. A rejection from `check` or `tick` (a closed page) ends the wait with that error.
 */
export async function waitUntil<T>(
  check: () => T | undefined | Promise<T | undefined>,
  { signal, tick, timeoutMs, now = Date.now }: WaitUntilOptions,
): Promise<T | null> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    // Listen before checking, so a change that lands while the check runs is not missed.
    const woken = signal.next();
    try {
      const value = await check();
      if (value !== undefined) return value;
      const ticked = tick();
      // If the signal wins, a later rejection of the tick must not go unhandled.
      ticked.catch(() => undefined);
      await Promise.race([woken.promise, ticked]);
    } finally {
      woken.cancel();
    }
  }
  return null;
}
