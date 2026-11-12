import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  firstCardFile,
  idCardFromDocuments,
  imagesToPdf,
} from '../../src/carriers/progressive/document.js';
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

describe('idCardFromDocuments', () => {
  const PNG_1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const b64 = (s: string) => Buffer.from(s, 'latin1').toString('base64');

  it('returns a PDF as is', async () => {
    const pdf = b64('%PDF-1.4\n%%EOF\n');
    const out = await idCardFromDocuments([pdf]);
    expect(Buffer.from(out).toString('latin1')).toBe('%PDF-1.4\n%%EOF\n');
  });

  it('turns the card images into one PDF, a page per image, skipping junk', async () => {
    const out = await idCardFromDocuments([PNG_1x1, b64('not an image'), PNG_1x1]);
    expect(Buffer.from(out.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect((await PDFDocument.load(out)).getPageCount()).toBe(2);
  });

  it('reports a response with no usable file as CARRIER_PAGE_CHANGED', async () => {
    for (const bad of [undefined, [], [7], [b64('junk')]]) {
      await expect(idCardFromDocuments(bad)).rejects.toMatchObject({
        code: 'CARRIER_PAGE_CHANGED',
      });
    }
  });
});

describe('firstCardFile', () => {
  const PNG_1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const b64 = (s: string) => Buffer.from(s, 'latin1').toString('base64');

  it('returns the first file as it came, typed by its bytes', () => {
    const png = firstCardFile([PNG_1x1, b64('%PDF-1.4')]);
    expect(png.mimeType).toBe('image/png');
    expect(png.extension).toBe('png');
    expect(Buffer.from(png.bytes).toString('base64')).toBe(PNG_1x1);
    expect(firstCardFile([b64('%PDF-1.4\n')]).mimeType).toBe('application/pdf');
    expect(firstCardFile([b64('\xff\xd8\xff\xe0jpeg')]).mimeType).toBe('image/jpeg');
  });

  it('reports a missing or unknown file as CARRIER_PAGE_CHANGED', () => {
    for (const bad of [undefined, [], [7], [b64('junk')]]) {
      expect(() => firstCardFile(bad)).toThrow(
        expect.objectContaining({ code: 'CARRIER_PAGE_CHANGED' }),
      );
    }
  });
});

describe('idCardFromDocuments off the main thread', () => {
  /** A large, noisy RGB PNG (noise compresses badly, so decoding it costs real CPU). */
  function bigPng(width: number, height: number): string {
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(zlib.crc32(td));
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // RGB
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
    for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0; // filter: none
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
  }

  it('keeps the event loop free while it converts (the first image is served meanwhile)', async () => {
    const card = bigPng(1600, 1000);
    let last = Date.now();
    let worstGap = 0;
    const tick = setInterval(() => {
      const now = Date.now();
      worstGap = Math.max(worstGap, now - last);
      last = now;
    }, 5);
    const pdf = await idCardFromDocuments([card, card, card, card]);
    clearInterval(tick);
    worstGap = Math.max(worstGap, Date.now() - last); // a loop that never ticked counts too
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(4);
    expect(worstGap).toBeLessThan(150);
  }, 30_000);

  it('the same conversion on this thread does block it (what the worker avoids)', async () => {
    const card = Buffer.from(bigPng(1600, 1000), 'base64');
    let last = Date.now();
    let worstGap = 0;
    const tick = setInterval(() => {
      const now = Date.now();
      worstGap = Math.max(worstGap, now - last);
      last = now;
    }, 5);
    await imagesToPdf([card, card, card, card].map((b) => new Uint8Array(b)));
    clearInterval(tick);
    worstGap = Math.max(worstGap, Date.now() - last); // a loop that never ticked counts too
    expect(worstGap).toBeGreaterThan(150);
  }, 30_000);
});
