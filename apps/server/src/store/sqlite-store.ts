import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Clock, SavedSession, SessionStore } from '../core/ports.js';
import type { Cipher } from '../infra/crypto.js';

interface Row {
  blob: string;
  expires_at: number;
}

/**
 * SessionStore on SQLite in DATA_DIR (Render's persistent disk). Each saved session is encrypted
 * with AES-256-GCM before it touches disk; only the opaque key, owner ID and expiry are plaintext.
 * A row that no longer decrypts (for example after SESSION_KEY rotation) is treated as missing
 * and deleted, so the user simply logs in again.
 */
export class SqliteSessionStore implements SessionStore {
  private readonly db: Database.Database;
  private readonly stmt;

  constructor(
    dataDir: string,
    private readonly cipher: Cipher,
    private readonly clock: Clock,
    fileName = 'sessions.db',
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, fileName));
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

  async get(key: string): Promise<SavedSession | undefined> {
    const row = this.stmt.get.get(key);
    if (!row) return undefined;
    if (row.expires_at <= this.clock.now()) {
      this.stmt.delete.run(key);
      return undefined;
    }
    try {
      return JSON.parse(this.cipher.decrypt(row.blob)) as SavedSession;
    } catch {
      this.stmt.delete.run(key);
      return undefined;
    }
  }

  async put(key: string, ownerId: string, session: SavedSession, ttlMs: number): Promise<void> {
    const blob = this.cipher.encrypt(JSON.stringify(session));
    this.stmt.put.run(key, ownerId, blob, this.clock.now() + ttlMs);
  }

  async delete(key: string): Promise<void> {
    this.stmt.delete.run(key);
  }

  async deleteByOwner(ownerId: string): Promise<number> {
    return this.stmt.deleteByOwner.run(ownerId).changes;
  }

  async purgeExpired(): Promise<number> {
    return this.stmt.purge.run(this.clock.now()).changes;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
