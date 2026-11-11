import type { Clock, SavedSession, SessionStore } from '../core/ports.js';

interface Entry {
  ownerId: string;
  session: SavedSession;
  expiresAt: number;
}

/** In-memory SessionStore for tests and local experiments. Lost on restart. */
export class MemorySessionStore implements SessionStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly clock: Clock) {}

  async get(key: string): Promise<SavedSession | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return structuredClone(entry.session);
  }

  async put(key: string, ownerId: string, session: SavedSession, ttlMs: number): Promise<void> {
    this.entries.set(key, {
      ownerId,
      session: structuredClone(session),
      expiresAt: this.clock.now() + ttlMs,
    });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async deleteByOwner(ownerId: string): Promise<number> {
    let n = 0;
    for (const [key, entry] of this.entries) {
      if (entry.ownerId === ownerId) {
        this.entries.delete(key);
        n++;
      }
    }
    return n;
  }

  async purgeExpired(): Promise<number> {
    const now = this.clock.now();
    let n = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        n++;
      }
    }
    return n;
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}
