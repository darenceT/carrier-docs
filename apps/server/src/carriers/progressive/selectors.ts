/**
 * Every URL and selector the Progressive adapter uses, in one place. From the Phase 2 spike
 * (docs/spike.md, "Portal mapping: Progressive") and the real-login runs:
 *
 * - Login is PingFederate's authentication API, driven by Progressive's login page. Its JSON
 *   responses carry a `status` (CREDENTIALS_REQUIRED, OTP_REQUIRED, MFA_COMPLETED, ...).
 * - After login the app lives on policyservicing.apps.progressive.com and calls
 *   api.progressive.com/policypro/ with a Bearer token it keeps in memory.
 * - The ID card PDF comes back base64 inside POST /policypro/v1/policies/<n>/document.
 */
export interface ProgressiveUrls {
  /** The login page (redirects through PingFederate). */
  login: string;
  /** The logged-in app's origin. */
  appOrigin: string;
  /** Path prefix of the logged-in app on appOrigin. */
  appPathPrefix: string;
  /** PingFederate's authentication API (matched by substring). */
  pfFlows: string;
  /** The account API base (matched by prefix). */
  api: string;
}

export const PROGRESSIVE_URLS: ProgressiveUrls = {
  login: 'https://account.apps.progressive.com/access/login?cntgrp=A&fd=accountHome',
  appOrigin: 'https://policyservicing.apps.progressive.com',
  appPathPrefix: '/app/',
  pfFlows: '/pf-ws/authn/flows',
  api: 'https://api.progressive.com/policypro/',
};

export const selectors = {
  username: {
    css: ['input[autocomplete="username"]', 'input[name*="user" i]', 'input[id*="user" i]'],
    label: /user ?(name|id)/i,
  },
  password: { css: ['input[type="password"]'], label: /password/i },
  code: {
    css: [
      'input[autocomplete="one-time-code"]',
      'input[name*="otp" i]',
      'input[name*="code" i]',
      'input[inputmode="numeric"]',
    ],
    label: /code|passcode|verification/i,
  },
  signIn: /sign in|log ?in/i,
  verify: /verify|submit|continue|sign in/i,
  /** Some versions first ask how to send the code. */
  sendText: /text|send( a)? code|sms/i,
  /** Clicking the label is what works on the real page (a custom-drawn checkbox). */
  remember: /remember (this )?device|trust this (device|browser)/i,
  /** The link in the account that opens the ID cards (the app then requests one itself). */
  idCards: /id cards?/i,
} as const;

/** What Progressive's pages say, for the BlockDetector. */
export const blockRules = {
  badCredentials: [/incorrect|doesn.?t match|invalid (user ?id|username|password)/i],
};
