/**
 * Pure helpers for the live-login script. No browser, no I/O, so they are unit-tested.
 */

/** Outcomes, named after the stable error codes in core/errors.ts (plus OK). */
export type Outcome =
  | 'OK'
  | 'BAD_CREDENTIALS'
  | 'MFA_INVALID'
  | 'MFA_TIMEOUT'
  | 'CARRIER_BLOCKED'
  | 'CARRIER_CHALLENGE'
  | 'CARRIER_PAGE_CHANGED'
  | 'CARRIER_UNAVAILABLE'
  /** A bug or unexpected state in this script, not the carrier. */
  | 'INTERNAL';

/** Text that bot-protection interstitials show. Same list as the spike, plus Cloudflare's. */
const BLOCK_PATTERNS: Array<[RegExp, 'CARRIER_BLOCKED' | 'CARRIER_CHALLENGE']> = [
  [/access denied/i, 'CARRIER_BLOCKED'],
  [/request (was )?blocked|you have been blocked|sorry, you have been blocked/i, 'CARRIER_BLOCKED'],
  [/reference #\s*[\d.a-f]+/i, 'CARRIER_BLOCKED'],
  [/pardon our interruption/i, 'CARRIER_CHALLENGE'],
  [/unusual (traffic|activity)/i, 'CARRIER_CHALLENGE'],
  [/are you (a )?(human|robot)|verify you are human/i, 'CARRIER_CHALLENGE'],
  [/checking your browser|please wait while we verify/i, 'CARRIER_CHALLENGE'],
  [
    /checking if the site connection is secure|performing security verification/i,
    'CARRIER_CHALLENGE',
  ],
];

const CHALLENGE_FRAME =
  /challenges\.cloudflare\.com|turnstile|captcha|hcaptcha|recaptcha|arkoselabs/i;

/**
 * Looks for a block page or a challenge in page text and frame URLs. Returns null when none.
 * A block wins over a challenge.
 */
export function detectBlock(
  text: string,
  frameUrls: readonly string[] = [],
): 'CARRIER_BLOCKED' | 'CARRIER_CHALLENGE' | null {
  let found: 'CARRIER_BLOCKED' | 'CARRIER_CHALLENGE' | null = null;
  for (const [re, kind] of BLOCK_PATTERNS) {
    if (re.test(text)) {
      if (kind === 'CARRIER_BLOCKED') return kind;
      found = kind;
    }
  }
  if (!found && frameUrls.some((u) => CHALLENGE_FRAME.test(u))) found = 'CARRIER_CHALLENGE';
  return found;
}

/** Text a portal shows for a wrong username, password or email. */
export function looksLikeBadCredentials(text: string): boolean {
  return /incorrect|invalid|doesn.?t match|not recognized|couldn.?t find|no account|try again/i.test(
    text,
  );
}

/**
 * Host and path only, with anything ID-like masked. Never includes the query string or fragment,
 * which can carry tokens or personal data.
 */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((seg) => (/\d/.test(seg) || seg.length > 24 ? '<id>' : seg))
      .join('/');
    return `${u.hostname}${path}`;
  } catch {
    return '<unparseable url>';
  }
}

export interface Step {
  name: string;
  ms: number;
}

/** Records step durations against a clock, so the output is a latency table. */
export class StepTimer {
  readonly steps: Step[] = [];
  private last: number;
  readonly started: number;

  constructor(private readonly now: () => number = Date.now) {
    this.started = now();
    this.last = this.started;
  }

  /** Ends the current step. */
  mark(name: string): void {
    const t = this.now();
    this.steps.push({ name, ms: t - this.last });
    this.last = t;
  }

  /** Restarts the clock without recording, e.g. after waiting for a human to type a code. */
  skip(): void {
    this.last = this.now();
  }

  /** Total of recorded steps (excludes skipped human waits). */
  get machineMs(): number {
    return this.steps.reduce((sum, s) => sum + s.ms, 0);
  }
}

export function formatSteps(steps: readonly Step[]): string {
  const width = Math.max(...steps.map((s) => s.name.length), 4);
  const lines = steps.map((s) => `  ${s.name.padEnd(width)}  ${String(s.ms).padStart(6)} ms`);
  const total = steps.reduce((sum, s) => sum + s.ms, 0);
  return [
    ...lines,
    `  ${'total (machine time)'.padEnd(width)}  ${String(total).padStart(6)} ms`,
  ].join('\n');
}

/** True for bytes that start like a PDF. */
export function isPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
}
