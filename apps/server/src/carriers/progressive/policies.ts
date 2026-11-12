import { idString } from '../shared.js';

export interface Policy {
  number: string;
  /** The key the document API needs with the number (`policyInfoKey`). */
  key: string;
}

/**
 * The policies in the account handshake. Found by searching rather than at a fixed path: every
 * object anywhere in the response with a `policyNumber` and a `policyInfoKey` (strings or
 * numbers), first occurrence of each number kept. Incomplete entries (a policy with no key) are
 * skipped, so one odd policy doesn't hide the others.
 */
export function findPolicies(body: unknown): Policy[] {
  const found = new Map<string, Policy>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 6 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    const number = idString(o.policyNumber);
    const key = idString(o.policyInfoKey);
    if (number && key && !found.has(number)) found.set(number, { number, key });
    for (const x of Object.values(o)) visit(x, depth + 1);
  };
  visit(body, 0);
  return [...found.values()];
}

/** The policy an ID-card request is for: `/policies/<number>/document?policyInfoKey=<key>`. */
export function policyFromDocumentUrl(url: string): Policy | undefined {
  try {
    const u = new URL(url);
    const m = /\/policies\/([^/]+)\/document/.exec(u.pathname);
    const number = m?.[1] ? decodeURIComponent(m[1]) : undefined;
    const key = u.searchParams.get('policyInfoKey') ?? undefined;
    return number && key ? { number, key } : undefined;
  } catch {
    return undefined;
  }
}
