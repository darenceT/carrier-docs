import { PDFDocument } from 'pdf-lib';
import { AppError } from '../../core/errors.js';

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];

/**
 * The ID card from Progressive's `documents[]` (base64 files). A PDF is returned as is. Images
 * (what the app itself asks for: one per card side) become one PDF, a page per image, so the user
 * gets a single document either way. Never logged: it's a user's document.
 */
export async function idCardFromDocuments(documents: unknown): Promise<Uint8Array> {
  const files = (Array.isArray(documents) ? documents : [])
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .map((d) => new Uint8Array(Buffer.from(d, 'base64')));
  if (files.length === 0) throw new AppError('CARRIER_PAGE_CHANGED', 'document shape');
  const pdf = files.find((f) => startsWith(f, PDF));
  if (pdf) return pdf;

  const out = await PDFDocument.create();
  for (const f of files) {
    let image;
    try {
      if (startsWith(f, PNG)) image = await out.embedPng(f);
      else if (startsWith(f, JPEG)) image = await out.embedJpg(f);
    } catch {
      image = undefined; // a corrupt image: skip it, keep the others
    }
    if (!image) continue;
    // Letter width (612 pt), or the image's own size if smaller.
    const scale = Math.min(1, 612 / image.width);
    const page = out.addPage([image.width * scale, image.height * scale]);
    page.drawImage(image, { x: 0, y: 0, width: image.width * scale, height: image.height * scale });
  }
  if (out.getPageCount() === 0)
    throw new AppError('CARRIER_PAGE_CHANGED', 'document is not a PDF or image');
  return out.save();
}

export interface CardFile {
  mimeType: 'application/pdf' | 'image/png' | 'image/jpeg';
  extension: 'pdf' | 'png' | 'jpg';
  bytes: Uint8Array;
}

/**
 * The first file of the ID card as it came (no conversion): the image the app shows first, or a
 * PDF. Served at once as the headline document; the full card is idCardFromDocuments, lazily.
 */
export function firstCardFile(documents: unknown): CardFile {
  const first = (Array.isArray(documents) ? documents : []).find(
    (d): d is string => typeof d === 'string' && d.length > 0,
  );
  if (!first) throw new AppError('CARRIER_PAGE_CHANGED', 'document shape');
  const bytes = new Uint8Array(Buffer.from(first, 'base64'));
  if (startsWith(bytes, PDF)) return { mimeType: 'application/pdf', extension: 'pdf', bytes };
  if (startsWith(bytes, PNG)) return { mimeType: 'image/png', extension: 'png', bytes };
  if (startsWith(bytes, JPEG)) return { mimeType: 'image/jpeg', extension: 'jpg', bytes };
  throw new AppError('CARRIER_PAGE_CHANGED', 'document is not a PDF or image');
}
