/**
 * Human-like timing on the login form only (design: "light jitter on the login form"). Document
 * fetches run at full speed: they happen inside the page, after login, where pacing buys nothing.
 */

/** The bit of a Playwright Locator that pacing drives. */
export interface TypeTarget {
  click(options?: { delay?: number }): Promise<void>;
  fill(value: string): Promise<void>;
  pressSequentially(text: string, options?: { delay?: number }): Promise<void>;
}

export interface Pacing {
  /** Focus a field and type into it. */
  type(target: TypeTarget, text: string): Promise<void>;
  /** Click a button or link. */
  click(target: Pick<TypeTarget, 'click'>): Promise<void>;
}

/** No delays: the mock portal and tests. */
export const noPacing: Pacing = {
  type: (target, text) => target.fill(text),
  click: (target) => target.click(),
};

export interface LightPacingOptions {
  /** Random number in [0, 1). Injected so tests are deterministic. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const between = (random: () => number, min: number, max: number) =>
  Math.round(min + random() * (max - min));

/**
 * A short pause before each field and click, and a per-key delay while typing. Bounded so a
 * 30-character password costs about 2-3 s, inside the 8 s budget's login allowance.
 */
export function lightPacing(options: LightPacingOptions = {}): Pacing {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    async type(target, text) {
      await sleep(between(random, 150, 400));
      await target.click({ delay: between(random, 30, 90) });
      // Playwright applies one delay per call, so the jitter is per field, not per key.
      await target.pressSequentially(text, { delay: between(random, 40, 110) });
    },
    async click(target) {
      await sleep(between(random, 200, 500));
      await target.click({ delay: between(random, 40, 120) });
    },
  };
}
