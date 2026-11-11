import type { Frame, Locator, Page } from 'patchright';
import { maskUrl } from './helpers.js';

export interface FieldQuery {
  /** CSS selectors to try, most specific first. */
  css: string[];
  /** Matches the field's visible label, placeholder or accessible name. */
  label?: RegExp;
}

/** Every way of finding the field, in one frame (the page itself or an embedded frame). */
export function candidates(frame: Frame, q: FieldQuery): Locator[] {
  const found = q.css.map((sel) => frame.locator(sel));
  if (q.label) {
    found.push(
      frame.getByLabel(q.label),
      frame.getByPlaceholder(q.label),
      frame.getByRole('textbox', { name: q.label }),
    );
  }
  return found.map((l) => l.first());
}

/** The first visible match on the page or in any of its frames, checked once. */
export async function findVisible(page: Page, q: FieldQuery): Promise<Locator | null> {
  for (const frame of page.frames()) {
    for (const loc of candidates(frame, q)) {
      if (await loc.isVisible().catch(() => false)) return loc;
    }
  }
  return null;
}

/**
 * Runs in the page. Kept as a plain-JavaScript string so build tools can't inject helpers the page
 * doesn't have. Reports attributes only; never `.value`.
 */
const DESCRIBE_FIELDS_JS = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  return Array.from(document.querySelectorAll('input, textarea, select, button'))
    .filter(visible)
    .map((el) => {
      const label = (el.labels && el.labels[0] && el.labels[0].textContent) || '';
      const attrs = {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        id: el.id || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        'aria-label': el.getAttribute('aria-label') || '',
        placeholder: el.getAttribute('placeholder') || '',
        label: label.trim(),
        text: el.tagName === 'BUTTON' ? (el.textContent || '').trim() : '',
      };
      return Object.entries(attrs)
        .filter(([, v]) => v)
        .map(([k, v]) => k + '=' + JSON.stringify(v.slice(0, 40)))
        .join(' ');
    });
})()`;

/**
 * Lists the visible form fields on the page and in its frames: type, name, id, autocomplete, label,
 * placeholder. Never the value. Used when a field can't be found, so the fix is one line.
 */
export async function describeFields(page: Page): Promise<string> {
  const lines: string[] = [];
  for (const frame of page.frames()) {
    const fields = await frame.evaluate<string[]>(DESCRIBE_FIELDS_JS).catch(() => [] as string[]);
    if (fields.length) {
      lines.push(`  in ${maskUrl(frame.url())}:`, ...fields.map((f) => `    ${f}`));
    }
  }
  return lines.length ? lines.join('\n') : '  (no visible form fields found)';
}
