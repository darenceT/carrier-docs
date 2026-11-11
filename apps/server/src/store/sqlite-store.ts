import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Clock, SavedSession, SessionStore } from '../core/ports.js';
import type { Cipher } from '../infra/crypto.js';

interface Row {
  blob: string;
  expires_at: number;
}

export interface SqliteStoreOptions {
  fileName?: string;
  /**
   * Called when a row exists but won't decrypt (wrong SESSION_KEY, or tampering). Gets no key and
   * no blob, so it's safe to log or count. A rising count after a deploy means a bad key.
   */
  onUndecryptable?: () => void;
}

/**
 * SessionStore on SQLite in DATA_DIR (Render's persistent disk).
 *
 * - Each saved session is encrypted with AES-256-GCM, bound to its row key as associated data, so
 *   a blob copied into another user's row won't decrypt.
 * - The owner ID (the browser-cookie ID used by "Forget me") is stored only as a keyed hash.
 * - A row that won't decrypt is treated as missing but NOT deleted: a mistyped SESSION_KEY on one
 *   deploy then loses nothing once the key is fixed. The TTL purge removes it in time, and the next
 *   successful login overwrites it.
 */
export class SqliteSessionStore implements SessionStore {
  private readonly db: Database.Database;
  private readonly stmt;
  private readonly onUndecryptable: () => void;

  constructor(
    dataDir: string,
    private readonly cipher: Cipher,
    private readonly clock: Clock,
    options: SqliteStoreOptions = {},
  ) {
    this.onUndecryptable = options.onUndecryptable ?? (() => {});
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, options.fileName ?? 'sessions.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        key        TEXT PRIMARY KEY,
        owner_id   TEXT NOT NULL,
        blob       TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_owner ON sessions (owner_id);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);
    `);
    this.stmt = {
      get: this.db.prepare<[string], Row>('SELECT blob, expires_at FROM sessions WHERE key = ?'),
      put: this.db.prepare<[string, string, string, number]>(
        `INSERT INTO sessions (key, owner_id, blob, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           owner_id = excluded.owner_id, blob = excluded.blob, expires_at = excluded.expires_at`,
      ),
      delete: this.db.prepare<[string]>('DELETE FROM sessions WHERE key = ?'),
      deleteByOwner: this.db.prepare<[string]>('DELETE FROM sessions WHERE owner_id = ?'),
      purge: this.db.prepare<[number]>('DELETE FROM sessions WHERE expires_at <= ?'),
    };
  }

  /** Owner IDs are bearer values (cookie IDs), so only a keyed hash of them touches disk. */
  private ownerHash(ownerId: string): string {
    return this.cipher.mac('owner', ownerId);
  }

  async get(key: string): Promise<SavedSession | undefined> {
    const row = this.stmt.get.get(key);
    if (!row) return undefined;
    if (row.expires_at <= this.clock.now()) {
      this.stmt.delete.run(key);
      return undefined;
    }
    try {
      return JSON.parse(this.cipher.decrypt(row.blob, key)) as SavedSession;
    } catch {
      this.onUndecryptable();
      return undefined;
    }
  }

  async put(key: string, ownerId: string, session: SavedSession, ttlMs: number): Promise<void> {
    const blob = this.cipher.encrypt(JSON.stringify(session), key);
    this.stmt.put.run(key, this.ownerHash(ownerId), blob, this.clock.now() + ttlMs);
  }

  async delete(key: string): Promise<void> {
    this.stmt.delete.run(key);
  }

  async deleteByOwner(ownerId: string): Promise<number> {
    return this.stmt.deleteByOwner.run(this.ownerHash(ownerId)).changes;
  }

  async purgeExpired(): Promise<number> {
    return this.stmt.purge.run(this.clock.now()).changes;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
