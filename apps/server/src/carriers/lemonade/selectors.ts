/**
 * Every URL and selector the Lemonade adapter uses, in one place. From the Phase 2 spike
 * (docs/spike.md, "Portal mapping: Lemonade"): login is email, then an SMS code; one API call
 * lists the policies, each with a cookie-free PDF link.
 */
export interface LemonadeUrls {
  /** The login page; the `#email` fragment opens the email step. */
  login: string;
  /** Submitting the email (sends the SMS). Matched by prefix. */
  presign: string;
  /** Submitting the code. Matched by prefix. */
  signin: string;
  /** The logged-in web app. */
  appHome: string;
  /** Lists the account's policies; each item's `form_url` is that policy's PDF. */
  policiesApi: string;
}

export const LEMONADE_URLS: LemonadeUrls = {
  login: 'https://www.lemonade.com/login#email',
  presign: 'https://www.lemonade.com/login/presign',
  signin: 'https://www.lemonade.com/login/signin',
  appHome: 'https://me.lemonade.com/',
  policiesApi: 'https://my.lemonade.com/api/v1/web_dashboard/accounts/home/policies',
};

export const selectors = {
  email: ['input[type="email"]', 'input[name*="email" i]', 'input[autocomplete="email"]'],
  code: [
    'input[autocomplete="one-time-code"]',
    'input[name*="code" i]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
  ],
} as const;

/** What Lemonade's own pages say, for the BlockDetector (Cloudflare's are in the base rules). */
export const blockRules = {
  blocked: [/sorry, you have been blocked/i],
  challenge: [/performing security verification|checking if the site connection is secure/i],
  badCredentials: [/couldn.?t find an account|no account|not recognized/i],
};
