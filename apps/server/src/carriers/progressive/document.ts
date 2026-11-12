import { AppError } from '../../core/errors.js';

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];

export interface CardFile {
  mimeType: 'application/pdf' | 'image/png' | 'image/jpeg';
  extension: 'pdf' | 'png' | 'jpg';
  bytes: Uint8Array;
}

/** The base64 files in Progressive's `documents[]`, in order (the app asks for images). */
export function cardFiles(documents: unknown): string[] {
  return (Array.isArray(documents) ? documents : []).filter(
    (d): d is string => typeof d === 'string' && d.length > 0,
  );
}

/**
 * One file of the ID card, as it came: no conversion (served at once, each its own document).
 * `index` counts from 0. Never logged: it's a user's document.
 */
export function cardFile(documents: unknown, index = 0): CardFile {
  const file = cardFiles(documents)[index];
  if (!file) throw new AppError('CARRIER_PAGE_CHANGED', 'document shape');
  const bytes = new Uint8Array(Buffer.from(file, 'base64'));
  if (startsWith(bytes, PDF)) return { mimeType: 'application/pdf', extension: 'pdf', bytes };
  if (startsWith(bytes, PNG)) return { mimeType: 'image/png', extension: 'png', bytes };
  if (startsWith(bytes, JPEG)) return { mimeType: 'image/jpeg', extension: 'jpg', bytes };
  throw new AppError('CARRIER_PAGE_CHANGED', 'document is not a PDF or image');
}
