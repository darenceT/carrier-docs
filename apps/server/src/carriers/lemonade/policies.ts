import type { DocumentMeta } from '@carrier-docs/contracts';
import { AppError } from '../../core/errors.js';
import { describeShape, idString, maskPolicyNumber, sortDocuments } from '../shared.js';

export interface ParsedPolicies {
  documents: DocumentMeta[];
  /** Document ID -> PDF link. The links are bearer credentials: never logged or stored. */
  links: Map<string, string>;
}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

function httpUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    return /^https?:$/.test(new URL(v).protocol) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One document per policy: the policy PDF. Renters has no ID card, so for Lemonade this PDF is
 * the first document shown. Document IDs are our own ("policy-1", ...), not Lemonade's IDs.
 *
 * Read tolerantly: `data.items` is keyed by policy ID (an array is accepted too), and one odd
 * item (a numeric id, a null field) is skipped rather than failing the whole list. Only a
 * response with no usable items at all is CARRIER_PAGE_CHANGED, and the error names its shape
 * (key names and types, never values) so the log says what changed.
 */
export function parsePolicies(body: unknown): ParsedPolicies {
  const items = (body as { data?: { items?: unknown } } | null)?.data?.items;
  const list =
    items && typeof items === 'object'
      ? Array.isArray(items)
        ? (items as unknown[])
        : Object.values(items as Record<string, unknown>)
      : undefined;
  if (!list) {
    throw new AppError('CARRIER_PAGE_CHANGED', `policies shape ${describeShape(body)}`);
  }

  const documents: DocumentMeta[] = [];
  const links = new Map<string, string>();
  let unreadable = 0;
  for (const raw of list) {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const policyId = idString(item.id);
    if (!policyId) {
      unreadable++;
      continue;
    }
    const link = httpUrl(item.form_url);
    if (!link) continue; // no PDF yet (e.g. a pending policy): nothing to show
    const id = `policy-${documents.length + 1}`;
    const type = text(item.humanized_type) ?? 'Policy';
    const address = text(item.address);
    const doc: DocumentMeta = {
      id,
      title: address ? `${type}: ${address}` : type,
      kind: 'policy',
      mimeType: 'application/pdf',
    };
    const masked = maskPolicyNumber(policyId);
    if (masked) doc.policyNumberMasked = masked;
    documents.push(doc);
    links.set(id, link);
  }
  if (documents.length === 0 && unreadable > 0) {
    throw new AppError('CARRIER_PAGE_CHANGED', `policies shape ${describeShape(body)}`);
  }
  return { documents: sortDocuments(documents), links };
}
