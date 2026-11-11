/**
 * Ports: the interfaces the core depends on. Implementations live outside core/
 * (infra/, store/, antibot/, carriers/) and are injected, so tests can pass fakes.
 */

/** Injectable time source, so timeouts and TTLs are testable in milliseconds. */
export interface Clock {
  now(): number;
}

/** One coherent device identity, kept per user and carrier so a returning user looks the same. */
export interface FingerprintProfile {
  userAgent: string;
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
}

/** What is saved between runs so a repeat run can skip login and MFA. Never a password. */
export interface SavedSession {
  carrierId: string;
  /** Browser storage state (cookies, local storage) as produced by the automation library. */
  storageState: unknown;
  fingerprint: FingerprintProfile;
  savedAt: number;
}

/**
 * Persistence for saved sessions. Keys are opaque reuse keys derived from the browser-cookie ID,
 * carrier and a keyed hash of the username. `ownerId` is the browser-cookie ID, used by "Forget me".
 */
export interface SessionStore {
  get(key: string): Promise<SavedSession | undefined>;
  put(key: string, ownerId: string, session: SavedSession, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** "Forget me": remove every saved session belonging to one browser. Returns how many. */
  deleteByOwner(ownerId: string): Promise<number>;
  /** Remove expired rows. Returns how many. */
  purgeExpired(): Promise<number>;
  close(): Promise<void>;
}
