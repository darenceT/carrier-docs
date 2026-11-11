import type { FingerprintProfile } from '../core/ports.js';

/**
 * One coherent device identity (design "Fingerprinting: coherence plus consistency"):
 *
 * - The UA names the Chromium version actually running, never a spoofed one, and stays honest
 *   about the OS (Linux): fonts, WebGL and navigator.platform would contradict a fake Windows.
 * - Timezone and locale match the egress IP (Render's Oregon region).
 * - A realistic 1920x1080 screen at scale 1, not the 1280x720 automation default.
 *
 * Generated once per user and carrier, then saved with the session and reused on every run, so
 * a returning user looks like the same device.
 */
export const DEFAULT_LOCALE = 'en-US';
export const DEFAULT_TIMEZONE = 'America/Los_Angeles';

/**
 * @param browserVersion what `browser.version()` reports, e.g. "141.0.7390.37". Chrome's UA
 *   carries only the major version ("141.0.0.0"), so that's what goes in.
 */
export function createFingerprint(browserVersion: string): FingerprintProfile {
  const major = /^(\d+)\./.exec(browserVersion)?.[1];
  if (!major) throw new Error('Unrecognized browser version');
  return {
    userAgent:
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/${major}.0.0.0 Safari/537.36`,
    locale: DEFAULT_LOCALE,
    timezoneId: DEFAULT_TIMEZONE,
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  };
}

/**
 * A saved profile is reused as is, unless the browser has since been upgraded: then its UA
 * would claim an engine that isn't running, an easier tell than a changed version. In that
 * case only the UA is refreshed; the rest of the identity stays the same.
 */
export function refreshFingerprint(
  saved: FingerprintProfile,
  browserVersion: string,
): FingerprintProfile {
  const current = createFingerprint(browserVersion);
  return saved.userAgent === current.userAgent ? saved : { ...saved, userAgent: current.userAgent };
}
