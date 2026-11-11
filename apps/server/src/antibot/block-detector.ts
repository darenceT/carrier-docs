import type { ErrorCode } from '../core/errors.js';

/**
 * Classifies a carrier page after a step (design: BlockDetector). Rules run on a snapshot of the
 * page, so they are pure and unit-tested; `snapshotPage` takes the snapshot from a real page.
 *
 * Verdicts follow the design's login outcomes and map to the stable error codes.
 */
export type BlockVerdict =
  'ok' | 'blocked' | 'challenge' | 'captcha' | 'bad_credentials' | 'page_changed';

/** What the rules look at. `text` is the visible text, trimmed; never logged (it may hold PII). */
export interface PageSnapshot {
  url: string;
  status?: number;
  title: string;
  text: string;
  /** URLs of every frame, for CAPTCHA and challenge widgets. */
  frameUrls: string[];
}

/** Per-carrier additions, from the spike's captures and the adapter's selectors. */
export interface CarrierBlockRules {
  blocked?: RegExp[];
  challenge?: RegExp[];
  badCredentials?: RegExp[];
}

/** Base rules: what any site's block page, bot challenge or CAPTCHA tends to look like. */
const BASE = {
  blockedStatus: new Set([403, 429]),
  blocked: [
    /access denied/i,
    /you have been blocked/i,
    /unusual (traffic|activity)/i,
    /request (was )?blocked/i,
    /are you a (robot|human)/i,
  ],
  challenge: [/just a moment\.{0,3}/i, /checking your browser/i, /verify you are human/i],
  captchaFrames: [
    /google\.com\/recaptcha/i,
    /recaptcha\.net/i,
    /hcaptcha\.com/i,
    /challenges\.cloudflare\.com/i,
    /captcha-delivery\.com/i, // DataDome
    /arkoselabs\.com|funcaptcha/i,
  ],
};

export class BlockDetector {
  private readonly rules: Required<CarrierBlockRules>;

  constructor(rules: CarrierBlockRules = {}) {
    this.rules = {
      blocked: rules.blocked ?? [],
      challenge: rules.challenge ?? [],
      badCredentials: rules.badCredentials ?? [],
    };
  }

  /**
   * Order matters: a CAPTCHA or block page can also contain "wrong password"-like text, and
   * reporting it as bad credentials would make the user retry and burn a failed login.
   */
  classify(page: PageSnapshot): BlockVerdict {
    if (page.frameUrls.some((u) => BASE.captchaFrames.some((r) => r.test(u)))) return 'captcha';
    const heading = `${page.title}\n${page.text}`;
    if ([...BASE.challenge, ...this.rules.challenge].some((r) => r.test(heading))) {
      return 'challenge';
    }
    if (page.status !== undefined && BASE.blockedStatus.has(page.status)) return 'blocked';
    if ([...BASE.blocked, ...this.rules.blocked].some((r) => r.test(heading))) return 'blocked';
    if (this.rules.badCredentials.some((r) => r.test(page.text))) return 'bad_credentials';
    return 'ok';
  }
}

/** The stable error code for a failed verdict. */
export function verdictToErrorCode(verdict: Exclude<BlockVerdict, 'ok'>): ErrorCode {
  switch (verdict) {
    case 'blocked':
      return 'CARRIER_BLOCKED';
    case 'challenge':
    case 'captcha':
      return 'CARRIER_CHALLENGE';
    case 'bad_credentials':
      return 'BAD_CREDENTIALS';
    case 'page_changed':
      return 'CARRIER_PAGE_CHANGED';
  }
}

/** The bit of a Playwright Page that a snapshot needs. */
export interface SnapshotSource {
  url(): string;
  title(): Promise<string>;
  innerText(selector: string): Promise<string>;
  frames(): { url(): string }[];
}

/** Snapshot a live page. `status` is the last navigation's HTTP status, if known. */
export async function snapshotPage(page: SnapshotSource, status?: number): Promise<PageSnapshot> {
  const [title, text] = await Promise.all([
    page.title().catch(() => ''),
    page.innerText('body').catch(() => ''),
  ]);
  return {
    url: page.url(),
    status,
    title,
    // Enough for the rules; bounded so a huge page can't make matching slow.
    text: text.trim().slice(0, 20_000),
    frameUrls: page.frames().map((f) => f.url()),
  };
}
