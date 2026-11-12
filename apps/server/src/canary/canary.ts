import type { Logger } from 'pino';
import {
  BlockDetector,
  snapshotPage,
  type BlockVerdict,
  type CarrierBlockRules,
} from '../antibot/index.js';
import type { SnapshotSource } from '../antibot/block-detector.js';
import type { FingerprintProfile } from '../core/ports.js';

/**
 * The login-page canary (design: Observability). For each carrier it opens the login page in a
 * fresh browser context through that carrier's anti-bot settings, and asks the BlockDetector
 * whether the page is clean. It never types, clicks or submits anything, so it can't lock an
 * account or send an MFA code. Page text is classified in memory and never logged or returned.
 */

export interface CanaryTarget {
  carrierId: string;
  loginUrl: string;
  rules?: CarrierBlockRules;
}

export type CanaryVerdict = 'clean' | 'challenged' | 'blocked' | 'error';

export interface CanaryResult {
  carrierId: string;
  verdict: CanaryVerdict;
  /** The BlockDetector label, or the error code for `error`. Never page text. */
  detail?: string;
  status?: number;
  ms: number;
}

export interface CanaryReport {
  /** True only if every login page loaded clean. */
  ok: boolean;
  checkedAt: string;
  results: CanaryResult[];
}

/** The bit of a Playwright Page the canary uses. */
export interface CanaryPage extends SnapshotSource {
  goto(url: string, options: { waitUntil: 'load' }): Promise<{ status(): number } | null>;
}

export interface CanaryBrowser {
  browserVersion(): Promise<string>;
  newContext(options: {
    fingerprint: FingerprintProfile;
    proxy?: { server: string; username?: string; password?: string };
  }): Promise<{ newPage(): Promise<CanaryPage>; close(): Promise<void> }>;
  proxy(): { server: string; username?: string; password?: string } | undefined;
}

export interface CanaryOptions {
  browserFor(carrierId: string): CanaryBrowser;
  createFingerprint(browserVersion: string): FingerprintProfile;
  logger: Logger;
  /** Time for scripts on the page to show a challenge after load. */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_SETTLE_MS = 3_000;

function toVerdict(label: BlockVerdict): CanaryVerdict {
  switch (label) {
    case 'challenge':
    case 'captcha':
      return 'challenged';
    case 'blocked':
      return 'blocked';
    // Nothing was submitted, so "bad credentials" text is just copy on the page.
    default:
      return 'clean';
  }
}

/** Checks targets one at a time: one extra browser context at most, on a 512 MB instance. */
export async function runCanary(
  targets: CanaryTarget[],
  options: CanaryOptions,
): Promise<CanaryReport> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const results: CanaryResult[] = [];

  for (const target of targets) {
    const started = now();
    let context: Awaited<ReturnType<CanaryBrowser['newContext']>> | undefined;
    let result: Omit<CanaryResult, 'ms'>;
    try {
      const browser = options.browserFor(target.carrierId);
      const fingerprint = options.createFingerprint(await browser.browserVersion());
      const proxy = browser.proxy();
      context = await browser.newContext(proxy ? { fingerprint, proxy } : { fingerprint });
      const page = await context.newPage();
      const response = await page.goto(target.loginUrl, { waitUntil: 'load' });
      await sleep(settleMs);
      const status = response?.status();
      const label = new BlockDetector(target.rules).classify(await snapshotPage(page, status));
      result = { carrierId: target.carrierId, verdict: toVerdict(label), detail: label };
      if (status !== undefined) result.status = status;
    } catch (err) {
      // Only the error's name: a message can carry a URL with query parameters.
      const name = err instanceof Error ? err.name : 'Error';
      result = { carrierId: target.carrierId, verdict: 'error', detail: name };
    } finally {
      await context?.close().catch(() => undefined);
    }
    const entry = { ...result, ms: now() - started };
    options.logger.info(
      { carrierId: entry.carrierId, verdict: entry.verdict, detail: entry.detail, ms: entry.ms },
      'canary result',
    );
    results.push(entry);
  }

  return {
    ok: results.every((r) => r.verdict === 'clean'),
    checkedAt: new Date(now()).toISOString(),
    results,
  };
}
