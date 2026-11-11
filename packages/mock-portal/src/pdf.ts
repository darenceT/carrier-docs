/**
 * A tiny hand-written PDF builder: one US Letter page of Helvetica text lines. Enough to produce
 * real, valid documents (correct xref byte offsets) that open in any browser PDF viewer, without
 * pulling in a PDF library. Text is restricted to printable ASCII.
 */

/** Escape a string for a PDF literal string `( ... )`, dropping anything outside printable ASCII. */
function pdfString(text: string): string {
  const ascii = text.replace(/[^\x20-\x7e]/g, '?');
  return `(${ascii.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

export interface PdfLine {
  text: string;
  /** Font size in points. Default 12. */
  size?: number;
}

/** Build a single-page PDF containing the given lines, top to bottom. */
export function buildPdf(lines: PdfLine[], title = 'Document'): Buffer {
  const left = 54;
  let y = 738;
  const ops: string[] = ['BT'];
  for (const line of lines) {
    const size = line.size ?? 12;
    ops.push(`/F1 ${size} Tf`, `1 0 0 1 ${left} ${y} Tm`, `${pdfString(line.text)} Tj`);
    y -= Math.round(size * 1.6);
  }
  ops.push('ET');
  const content = ops.join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Title ${pdfString(title)} /Producer (carrier-docs mock portal) >>`,
  ];

  // The binary comment on line 2 tells tools the file contains 8-bit data, per the PDF spec.
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  out +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
