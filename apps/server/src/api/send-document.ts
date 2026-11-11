import { Readable } from 'node:stream';
import type { Context } from 'koa';
import type { DocumentContent } from '../core/ports.js';

/** Types the browser may render inline. Anything else is served as a download-only byte stream. */
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif']);

/** A filename safe for Content-Disposition: no paths, quotes, control or reserved characters. */
export function safeFilename(name: string, fallback = 'document.pdf'): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"*:<>?|;%]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 100)
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

export function sendDocument(ctx: Context, doc: DocumentContent): void {
  const mimeType = doc.mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const inline = INLINE_TYPES.has(mimeType);
  ctx.attachment(safeFilename(doc.filename), { type: inline ? 'inline' : 'attachment' });
  ctx.type = inline ? mimeType : 'application/octet-stream';
  ctx.set('Cache-Control', 'no-store');
  ctx.set('X-Content-Type-Options', 'nosniff');
  ctx.body =
    doc.body instanceof Uint8Array
      ? Buffer.from(doc.body.buffer, doc.body.byteOffset, doc.body.byteLength)
      : Readable.from(doc.body);
}
