import type { Browser } from 'patchright';
import type { BrowserStrategy } from '../infra/config.js';

/**
 * Launches the browser process for one strategy (design D2). Carrier code never launches a
 * browser itself; the strategy is chosen per carrier in config and the pool calls `launch`.
 */
export interface BrowserProvider {
  readonly strategy: BrowserStrategy;
  launch(): Promise<Browser>;
}

export interface BrowserProviderOptions {
  /** Use this Chromium binary instead of the library's bundled one (tests, odd hosts). */
  executablePath?: string;
  /** Read for the headed strategy; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export function createBrowserProvider(
  strategy: BrowserStrategy,
  options: BrowserProviderOptions = {},
): BrowserProvider {
  const executablePath = options.executablePath || undefined;
  const env = options.env ?? process.env;

  switch (strategy) {
    case 'patched-headless':
      return { strategy, launch: () => launchPatched({ headless: true, executablePath }) };

    case 'patched-headed':
      return {
        strategy,
        launch: () => {
          if (process.platform === 'linux' && !env.DISPLAY) {
            // Headed on a server needs a virtual display (Xvfb). The image doesn't ship one yet.
            return Promise.reject(
              new Error('patched-headed needs a display: run under Xvfb (DISPLAY is not set)'),
            );
          }
          return launchPatched({ headless: false, executablePath });
        },
      };

    case 'stock-headless':
      return { strategy, launch: () => launchStock({ headless: true, executablePath }) };

    case 'stock-new-headless':
      // Full Chromium in new headless mode, via the "chromium" channel.
      return {
        strategy,
        launch: () => launchStock({ headless: true, channel: 'chromium', executablePath }),
      };
  }
}

interface LaunchOptions {
  headless: boolean;
  channel?: string;
  executablePath: string | undefined;
}

/**
 * By default the library closes the browser itself on SIGTERM, SIGINT and SIGHUP. On a deploy
 * that killed every login in flight within milliseconds, before the server's own shutdown could
 * let them finish (drain, then close the pool). The server owns shutdown: signals are left to it.
 */
export const SIGNALS_LEFT_TO_THE_SERVER = {
  handleSIGTERM: false,
  handleSIGINT: false,
  handleSIGHUP: false,
} as const;

async function launchPatched(options: LaunchOptions): Promise<Browser> {
  const { chromium } = await import('patchright');
  return chromium.launch({ ...options, ...SIGNALS_LEFT_TO_THE_SERVER });
}

/**
 * Stock Playwright, the baseline. `playwright` is a dev dependency, so it isn't in the
 * production image: these strategies are for local comparison runs only.
 */
async function launchStock(options: LaunchOptions): Promise<Browser> {
  let playwright: typeof import('playwright');
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error('stock strategies need the playwright package (a dev dependency)');
  }
  const browser = await playwright.chromium.launch({ ...options, ...SIGNALS_LEFT_TO_THE_SERVER });
  // playwright and patchright expose the same Browser API; the types differ only nominally.
  return browser as unknown as Browser;
}
