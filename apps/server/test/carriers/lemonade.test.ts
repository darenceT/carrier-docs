import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePolicies } from '../../src/carriers/lemonade/policies.js';
import { AppError } from '../../src/core/errors.js';

// Synthetic: same field names as Lemonade's real response (docs/spike.md), invented values.
const fixture = JSON.parse(
  readFileSync(new URL('../../../../fixtures/lemonade/policies.json', import.meta.url), 'utf8'),
) as unknown;

describe('parsePolicies (Lemonade)', () => {
  it('turns each policy with a PDF link into one document, with our own IDs', () => {
    const { documents, links } = parsePolicies(fixture);
    expect(documents).toEqual([
      {
        id: 'policy-1',
        title: 'Renters Policy: 1 Example St, Apt 1, Exampletown, WA',
        kind: 'policy',
        mimeType: 'application/pdf',
        policyNumberMasked: '••••KE01',
      },
      {
        id: 'policy-2',
        title: 'Renters Policy: 2 Sample Ave, Sampleville, WA',
        kind: 'policy',
        mimeType: 'application/pdf',
        policyNumberMasked: '••••KE02',
      },
    ]);
    expect(links.get('policy-1')).toBe('https://icebox.lemonade.com/tokens/FAKE-TOKEN-ONE');
    expect(links.size).toBe(2); // the quote without a form_url is skipped
  });

  it('never exposes the PDF link or the full policy ID in the document list', () => {
    const json = JSON.stringify(parsePolicies(fixture).documents);
    expect(json).not.toContain('icebox');
    expect(json).not.toContain('LP0000FAKE01');
  });

  it('falls back to "Policy" when the type is missing', () => {
    const { documents } = parsePolicies({
      data: { items: { a: { id: 'x', form_url: 'https://icebox.example/t' } } },
    });
    expect(documents[0]?.title).toBe('Policy');
  });

  it('reports a changed response shape as CARRIER_PAGE_CHANGED', () => {
    for (const bad of [null, {}, { data: {} }, { data: { items: [] } }]) {
      try {
        parsePolicies(bad);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('CARRIER_PAGE_CHANGED');
      }
    }
  });
});
