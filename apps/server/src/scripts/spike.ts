/// <reference lib="dom" />
/**
 * Anti-bot spike harness (Build Guide, Phase 2).
 *
 * Loads bot-check pages and carrier LOGIN PAGES with each browser strategy and
 * records what happened. It never fills or submits a form, so it can't lock an
 * account or use up an MFA code.
 *
 * Usage (local, from the repo root):
 *   npm run spike --                          # bot-check pages only
 *   npm run spike -- https://<carrier-login>  # add carrier login pages
 *   npm run spike -- --memory https://<url>   # memory with 1..3 contexts
 *   npm run spike -- --memory --max-contexts=2 https://<url>
 *
 * On Render (Shell tab): node apps/server/dist/scripts/spike.js [--memory] <login-url>
 *
 * Memory mode reads the container's own cgroup counters (Linux), which are what the platform
 * enforces. It stops before opening another context once the container is above 85% of its
 * limit, so a measurement can't get the service killed, and it appends every step to a log file
 * so a crash doesn't lose the numbers.
 *
 * Env:
 *   SPIKE_STRATEGIES=stock-headless,stock-new-headless,patched-headless
 *   SPIKE_SETTLE_MS=5000   time to let anti-bot sensor scripts run
 *   SPIKE_OUT=spike-results
 *   BROWSER_EXECUTABLE_PATH=...   optional: launch this browser binary instead of the bundled one
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserType } from 'playwright';

const STRATEGIES = ['stock-headless', 'stock-new-headless', 'patched-headless'] as const;
type Strategy = (typeof STRATEGIES)[number];

interface Result {
  strategy: Strategy;
  url: string;
  ok: boolean;
  status: number | null;
  finalUrl: string | null;
  title: string | null;
  verdict: 'clean' | 'challenge' | 'blocked' | 'error';
  markers: string[];
  webdriver: unknown;
  domContentLoadedMs: number | null;
  loadMs: number | null;
  wallMs: number;
  browserRssMb: number | null;
  error?: string;
}

const BOT_CHECKS = ['https://bot.sannysoft.com/', 'https://abrahamjuliot.github.io/creepjs/'];

// Text that bot-protection interstitials commonly show. Tune per carrier after the spike.
const BLOCK_PATTERNS: Array<[RegExp, 'challenge' | 'blocked']> = [
  [/access denied/i, 'blocked'],
  [/request (was )?blocked|you have been blocked/i, 'blocked'],
  [/reference #\s*[\d.a-f]+/i, 'blocked'],
  [/pardon our interruption/i, 'challenge'],
  [/unusual (traffic|activity)/i, 'challenge'],
  [/are you (a )?(human|robot)|verify you are human/i, 'challenge'],
  [/checking your browser|please wait while we verify/i, 'challenge'],
];
const CAPTCHA_FRAME = /captcha|hcaptcha|recaptcha|turnstile|arkoselabs|funcaptcha/i;

// Same identity rules as the design: honest browser, timezone and locale matching the Oregon egress.
const CONTEXT_OPTIONS = {
  locale: 'en-US',
  timezoneId: 'America/Los_Angeles',
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
} as const;

const settleMs = Number(process.env.SPIKE_SETTLE_MS ?? 5000);
// On Render the app directory is read-only for the node user, so default to /tmp there.
const outDir =
  process.env.SPIKE_OUT ?? (process.env.RENDER ? '/tmp/spike-results' : 'spike-results');

async function launcher(
  strategy: Strategy,
): Promise<{ type: BrowserType; options: Record<string, unknown> }> {
  const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
  const base = { headless: true, ...(executablePath ? { executablePath } : {}) };
  if (strategy === 'patched-headless') {
    // patchright is a drop-in Playwright replacement with automation leaks patched.
    const mod = (await import('patchright')) as unknown as { chromium: BrowserType };
    return { type: mod.chromium, options: base };
  }
  const { chromium } = await import('playwright');
  if (strategy === 'stock-new-headless') {
    // channel 'chromium' runs the full browser in new headless mode instead of the headless shell.
    return { type: chromium, options: { ...base, channel: 'chromium' } };
  }
  return { type: chromium, options: base };
}

/**
 * Resident memory of every process this script spawned (the browser and its renderers),
 * excluding Node itself. Linux and macOS only; on Windows use Task Manager.
 */
function browserRssMb(): number | null {
  if (process.platform === 'win32') return null;
  try {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number));
    const children = new Map<number, number[]>();
    const rss = new Map<number, number>();
    for (const [p = 0, pp = 0, r = 0] of rows) {
      rss.set(p, r);
      children.set(pp, [...(children.get(pp) ?? []), p]);
    }
    let total = 0;
    const stack = [...(children.get(process.pid) ?? [])];
    while (stack.length) {
      const p = stack.pop()!;
      total += rss.get(p) ?? 0;
      stack.push(...(children.get(p) ?? []));
    }
    return Math.round(total / 1024);
  } catch {
    return null;
  }
}

async function probe(browser: Browser, strategy: Strategy, url: string): Promise<Result> {
  const started = Date.now();
  const base: Result = {
    strategy,
    url,
    ok: false,
    status: null,
    finalUrl: null,
    title: null,
    verdict: 'error',
    markers: [],
    webdriver: null,
    domContentLoadedMs: null,
    loadMs: null,
    wallMs: 0,
    browserRssMb: null,
  };
  const context = await browser.newContext(CONTEXT_OPTIONS);
  try {
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(settleMs);

    const body =
      (await page
        .locator('body')
        .innerText({ timeout: 5_000 })
        .catch(() => '')) ?? '';
    const markers: string[] = [];
    let verdict: Result['verdict'] = 'clean';
    for (const [re, kind] of BLOCK_PATTERNS) {
      const m = body.match(re);
      if (m) {
        markers.push(m[0]);
        if (kind === 'blocked' || verdict === 'clean') verdict = kind;
      }
    }
    if (page.frames().some((f) => CAPTCHA_FRAME.test(f.url()))) {
      markers.push('captcha iframe');
      if (verdict === 'clean') verdict = 'challenge';
    }
    const status = response?.status() ?? null;
    if (status !== null && status >= 400 && verdict === 'clean') {
      markers.push(`HTTP ${status}`);
      verdict = status === 403 || status === 429 ? 'blocked' : 'challenge';
    }

    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as
        PerformanceNavigationTiming | undefined;
      return {
        webdriver: (navigator as Navigator & { webdriver?: boolean }).webdriver,
        dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        load: nav && nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd) : null,
      };
    });

    mkdirSync(join(outDir, 'screens'), { recursive: true });
    // Hostname plus a path slug, so two URLs on one host don't overwrite each other.
    const u = new URL(url);
    const slug = `${u.hostname}${u.pathname}`.replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '');
    const shot = `${strategy}-${slug}.png`;
    await page.screenshot({ path: join(outDir, 'screens', shot), fullPage: false }).catch(() => {});

    return {
      ...base,
      ok: true,
      status,
      finalUrl: page.url(),
      title: await page.title(),
      verdict,
      markers,
      webdriver: timing.webdriver,
      domContentLoadedMs: timing.dcl,
      loadMs: timing.load,
      wallMs: Date.now() - started,
      browserRssMb: browserRssMb(),
    };
  } catch (err) {
    return { ...base, wallMs: Date.now() - started, error: (err as Error).message.split('\n')[0] };
  } finally {
    await context.close();
  }
}

interface ContainerMemory {
  /** The enforced limit, or null if unlimited. */
  limitMb: number | null;
  currentMb: number;
  /** Highest usage since the container started (kernel 5.19+), or null. */
  peakMb: number | null;
  /** Program memory: can't be reclaimed. */
  anonMb: number | null;
  /** Page cache: the kernel frees it under pressure. */
  fileMb: number | null;
}

const MB = 1024 * 1024;
// SPIKE_CGROUP_DIR exists for testing the parser against fake counter files.
const CGROUP = process.env.SPIKE_CGROUP_DIR ?? '/sys/fs/cgroup';

/** The container's memory as the platform sees it (cgroup v2). Null where there is no cgroup. */
function containerMemory(): ContainerMemory | null {
  try {
    const read = (name: string): string => readFileSync(join(CGROUP, name), 'utf8').trim();
    const optional = (name: string): string | null => {
      try {
        return read(name);
      } catch {
        return null;
      }
    };
    const toMb = (bytes: string | null): number | null =>
      bytes === null || bytes === 'max' ? null : Math.round(Number(bytes) / MB);
    const stat = optional('memory.stat') ?? '';
    const statMb = (key: string): number | null => {
      const m = stat.match(new RegExp(`^${key} (\\d+)$`, 'm'));
      return m ? Math.round(Number(m[1]) / MB) : null;
    };
    return {
      limitMb: toMb(read('memory.max')),
      currentMb: toMb(read('memory.current')) ?? 0,
      peakMb: toMb(optional('memory.peak')),
      anonMb: statMb('anon'),
      fileMb: statMb('file'),
    };
  } catch {
    return null;
  }
}

function describeMemory(): string {
  const node = `node ${Math.round(process.memoryUsage().rss / MB)} MB`;
  const c = containerMemory();
  if (!c)
    return `browser processes ${browserRssMb() ?? 'n/a'} MB (overcounts shared memory), ${node}`;
  const of = c.limitMb === null ? '' : ` of ${c.limitMb} MB`;
  return (
    `container ${c.currentMb} MB${of} (program ${c.anonMb ?? '?'} MB, cache ${c.fileMb ?? '?'} MB), ` +
    `peak ${c.peakMb ?? '?'} MB, ${node}`
  );
}

/** Stop before the next context if the container is already above this share of its limit. */
const SAFETY_FRACTION = 0.85;

/**
 * Opens 1..maxContexts contexts on the same page and reports memory after each. Every line is
 * printed and appended to a log file at once, so the numbers survive if the container is killed.
 */
async function memoryRun(strategy: Strategy, url: string, maxContexts: number): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const logFile = join(outDir, `memory-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const log = (line: string): void => {
    console.log(line);
    appendFileSync(logFile, `${line}\n`);
  };

  let browser: Browser;
  try {
    const { type, options } = await launcher(strategy);
    browser = await type.launch(options);
  } catch (err) {
    console.warn(`skip ${strategy}: ${(err as Error).message.split('\n')[0]}`);
    return;
  }

  const contexts = [];
  try {
    log(`\nmemory, ${strategy}, ${url}`);
    log(`  before any context: ${describeMemory()}`);
    for (let n = 1; n <= maxContexts; n++) {
      const c = containerMemory();
      if (c?.limitMb && c.currentMb > c.limitMb * SAFETY_FRACTION) {
        log(
          `  stopped before context ${n}: container at ${c.currentMb} of ${c.limitMb} MB ` +
            `(over ${SAFETY_FRACTION * 100}%), another context risks an out-of-memory kill`,
        );
        break;
      }
      const ctx = await browser.newContext(CONTEXT_OPTIONS);
      contexts.push(ctx);
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(settleMs);
      log(`  ${n} context(s): ${describeMemory()}`);
    }
  } finally {
    for (const c of contexts) await c.close();
    await browser.close();
    console.log(`saved ${logFile}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const memory = args.includes('--memory');
  const urls = args.filter((a) => !a.startsWith('--'));
  const strategies = (
    process.env.SPIKE_STRATEGIES ?? 'stock-headless,stock-new-headless,patched-headless'
  )
    .split(',')
    .map((s) => s.trim());
  const unknown = strategies.filter((s) => !(STRATEGIES as readonly string[]).includes(s));
  if (unknown.length) {
    throw new Error(
      `unknown SPIKE_STRATEGIES: ${unknown.join(', ')} (use ${STRATEGIES.join(', ')})`,
    );
  }
  for (const u of urls) {
    if (!URL.canParse(u)) throw new Error(`not a URL: ${u}`);
  }

  if (memory) {
    const maxArg = args.find((a) => a.startsWith('--max-contexts='));
    const maxContexts = maxArg ? Number(maxArg.split('=')[1]) : 3;
    if (!Number.isInteger(maxContexts) || maxContexts < 1) {
      throw new Error('--max-contexts must be a whole number of at least 1');
    }
    for (const s of strategies) {
      await memoryRun(s as Strategy, urls[0] ?? BOT_CHECKS[0]!, maxContexts);
    }
    return;
  }

  const targets = [...BOT_CHECKS, ...urls];
  const results: Result[] = [];
  for (const strategy of strategies) {
    let browser: Browser;
    try {
      const launched = await launcher(strategy as Strategy);
      browser = await launched.type.launch(launched.options);
    } catch (err) {
      // One missing browser shouldn't abort the other strategies.
      console.warn(`skip ${strategy}: ${(err as Error).message.split('\n')[0]}`);
      continue;
    }
    try {
      for (const url of targets) {
        const r = await probe(browser, strategy as Strategy, url);
        results.push(r);
        console.log(
          `${r.verdict.padEnd(9)} ${strategy.padEnd(18)} ${url}${r.error ? `  (${r.error})` : ''}`,
        );
      }
    } finally {
      await browser.close();
    }
  }

  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `spike-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify({ host: process.env.RENDER_SERVICE_NAME ?? 'local', results }, null, 2),
  );
  console.table(
    results.map((r) => ({
      strategy: r.strategy,
      host: new URL(r.url).hostname,
      verdict: r.verdict,
      status: r.status,
      webdriver: r.webdriver,
      dclMs: r.domContentLoadedMs,
      wallMs: r.wallMs,
      rssMb: r.browserRssMb,
      markers: r.markers.join('; '),
    })),
  );
  console.log(`saved ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
