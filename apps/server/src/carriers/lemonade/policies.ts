import type { DocumentMeta } from '@carrier-docs/contracts';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { maskPolicyNumber, sortDocuments } from '../shared.js';

/**
 * The policies response, validated: only the fields the adapter reads. A shape change is
 * CARRIER_PAGE_CHANGED rather than a crash. `data.items` is keyed by policy ID.
 */
const policiesResponse = z.object({
  data: z.object({
    items: z.record(
      z.string(),
      z.object({
        id: z.string().min(1),
        humanized_type: z.string().optional(),
        address: z.string().optional(),
        form_url: z.string().url().optional(),
      }),
    ),
  }),
});

export interface ParsedPolicies {
  documents: DocumentMeta[];
  /** Document ID -> PDF link. The links are bearer credentials: never logged or stored. */
  links: Map<string, string>;
}

/**
 * One document per policy: the policy PDF. Renters has no ID card, so for Lemonade this PDF is
 * the first document shown. Document IDs are our own ("policy-1", ...), not Lemonade's IDs.
 */
export function parsePolicies(body: unknown): ParsedPolicies {
  const parsed = policiesResponse.safeParse(body);
  if (!parsed.success) throw new AppError('CARRIER_PAGE_CHANGED', 'policies response shape');

  const documents: DocumentMeta[] = [];
  const links = new Map<string, string>();
  let n = 0;
  for (const item of Object.values(parsed.data.data.items)) {
    if (!item.form_url) continue;
    const id = `policy-${++n}`;
    const type = item.humanized_type?.trim() || 'Policy';
    const doc: DocumentMeta = {
      id,
      title: item.address ? `${type}: ${item.address}` : type,
      kind: 'policy',
      mimeType: 'application/pdf',
    };
    const masked = maskPolicyNumber(item.id);
    if (masked) doc.policyNumberMasked = masked;
    documents.push(doc);
    links.set(id, item.form_url);
  }
  return { documents: sortDocuments(documents), links };
}
