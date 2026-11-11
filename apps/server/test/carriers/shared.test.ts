import type { DocumentMeta } from '@carrier-docs/contracts';
import { describe, expect, it } from 'vitest';
import { filenameFrom, maskPolicyNumber, sortDocuments, step } from '../../src/carriers/shared.js';
import { AppError } from '../../src/core/errors.js';

const doc = (id: string, kind: DocumentMeta['kind']): DocumentMeta => ({
  id,
  title: id,
  kind,
  mimeType: 'application/pdf',
});

describe('carrier helpers', () => {
  it('puts ID cards first, then declarations, keeping the carrier order within a kind', () => {
    const sorted = sortDocuments([
      doc('packet', 'policy'),
      doc('dec-1', 'declarations'),
      doc('misc', 'other'),
      doc('card-1', 'id_card'),
      doc('dec-2', 'declarations'),
      doc('card-2', 'id_card'),
    ]);
    expect(sorted.map((d) => d.id)).toEqual([
      'card-1',
      'card-2',
      'dec-1',
      'dec-2',
      'packet',
      'misc',
    ]);
  });

  it('masks policy numbers to the last 4 characters', () => {
    expect(maskPolicyNumber('DEMO-0000-1234')).toBe('••••1234');
    expect(maskPolicyNumber('AB 12 34 CD')).toBe('••••34CD');
    expect(maskPolicyNumber('123')).toBeUndefined();
  });

  it('reads a filename from Content-Disposition', () => {
    expect(filenameFrom('attachment; filename="auto-id-card.pdf"')).toBe('auto-id-card.pdf');
    expect(filenameFrom('inline; filename=card.pdf')).toBe('card.pdf');
    expect(filenameFrom('inline')).toBeUndefined();
  });

  it('turns a missing element into CARRIER_PAGE_CHANGED, keeping AppErrors as they are', async () => {
    await expect(
      step('login form', () => Promise.reject(new Error('Timeout 30000ms exceeded'))),
    ).rejects.toMatchObject({ code: 'CARRIER_PAGE_CHANGED' });
    await expect(
      step('x', () => Promise.reject(new AppError('SESSION_EXPIRED'))),
    ).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect(step('x', async () => 42)).resolves.toBe(42);
  });
});
