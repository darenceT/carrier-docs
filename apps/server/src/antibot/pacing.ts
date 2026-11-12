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
  /**
   * Focus a field and fill it in one go, as a password manager or the browser's autofill does
   * (the common case for passwords and email addresses). Much faster than typing.
   */
  autofill(target: TypeTarget, text: string): Promise<void>;
  /** Click a button or link. */
  click(target: Pick<TypeTarget, 'click'>): Promise<void>;
}

/** No delays: the mock portal and tests. */
export const noPacing: Pacing = {
  type: (target, text) => target.fill(text),
  autofill: (target, text) => target.fill(text),
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
 * 20-character username costs about 1 s. Secrets and emails are autofilled instead.
 */
export function lightPacing(options: LightPacingOptions = {}): Pacing {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    async type(target, text) {
      await sleep(between(random, 100, 250));
      await target.click({ delay: between(random, 30, 90) });
      // Playwright applies one delay per call, so the jitter is per field, not per key.
      await target.pressSequentially(text, { delay: between(random, 30, 70) });
    },
    async autofill(target, text) {
      await sleep(between(random, 100, 250));
      await target.click({ delay: between(random, 30, 90) });
      await target.fill(text);
    },
    async click(target) {
      await sleep(between(random, 200, 500));
      await target.click({ delay: between(random, 40, 120) });
    },
  };
}
