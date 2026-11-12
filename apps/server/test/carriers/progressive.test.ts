import { describe, expect, it } from 'vitest';
import { findPolicies, policyFromDocumentUrl } from '../../src/carriers/progressive/policies.js';
import { describeShape } from '../../src/carriers/shared.js';

describe('findPolicies (Progressive handshake)', () => {
  it('reads the shape seen in the spike', () => {
    expect(
      findPolicies({
        policySessions: [
          { policyNumber: '1111', policySessionId: 'a', policyInfoKey: 'WA-AA' },
          { policyNumber: '2222', policySessionId: 'b', policyInfoKey: 'OR-AA' },
        ],
      }),
    ).toEqual([
      { number: '1111', key: 'WA-AA' },
      { number: '2222', key: 'OR-AA' },
    ]);
  });

  it('finds policies nested anywhere, with numeric values, skipping incomplete and repeated ones', () => {
    expect(
      findPolicies({
        account: {
          sessions: { items: [{ policy: { policyNumber: 3333, policyInfoKey: 7 } }] },
          other: [{ policyNumber: '4444' }, { policyNumber: 3333, policyInfoKey: 'dup' }],
        },
      }),
    ).toEqual([{ number: '3333', key: '7' }]);
  });

  it('finds nothing in an unrelated body', () => {
    expect(findPolicies(null)).toEqual([]);
    expect(findPolicies('not JSON')).toEqual([]);
    expect(findPolicies({ policies: [{ number: '1', key: 'k' }] })).toEqual([]);
  });
});

describe('policyFromDocumentUrl', () => {
  it('reads the number and key from the app’s ID-card request', () => {
    expect(
      policyFromDocumentUrl(
        'https://api.example/policypro/v1/policies/12%2034/document?policyInfoKey=WA-1',
      ),
    ).toEqual({ number: '12 34', key: 'WA-1' });
    expect(policyFromDocumentUrl('https://api.example/policypro/v1/policies/1/document')).toBe(
      undefined,
    );
    expect(policyFromDocumentUrl('not a url')).toBe(undefined);
  });
});

describe('describeShape', () => {
  it('gives key names and types, never values', () => {
    expect(
      describeShape({ a: 'secret', b: 1, c: true, d: null, e: [{ f: 'x' }], g: [], h: {} }),
    ).toBe('{a:s,b:n,c:b,d:null,e:[{f:s}],g:[],h:{}}');
  });

  it('masks keys that could be data, and bounds depth and width', () => {
    expect(describeShape({ LP0000FAKE01: 1, 'a-b': 2 })).toBe('{#:n,#:n}');
    expect(describeShape({ a: { b: { c: { d: { e: 1 } } } } })).toBe('{a:{b:{c:{d:{…}}}}}');
    const wide = Object.fromEntries('abcdefghij'.split('').map((k) => [k, 1]));
    expect(describeShape(wide)).toBe('{a:n,b:n,c:n,d:n,e:n,f:n,g:n,h:n,…}');
  });
});
