import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12; // GCM standard nonce size
const TAG_BYTES = 16;

/** Exactly 32 bytes in canonical base64: 43 characters plus one '=' of padding. */
const BASE64_KEY_32 = /^[A-Za-z0-9+/]{43}=$/;

export interface Cipher {
  /**
   * AES-256-GCM with a random IV per call. Output: "v1.<base64url(iv | tag | ciphertext)>".
   * `aad` (associated data) is authenticated but not stored; decrypt must pass the same value.
   * The session store passes the row key, so a blob copied to another row won't decrypt.
   */
  encrypt(plaintext: string, aad?: string): string;
  /** Throws if the token was tampered with, made with another key, or bound to another `aad`. */
  decrypt(token: string, aad?: string): string;
  /** Keyed, deterministic hash (HMAC-SHA256, hex). Used for reuse keys and username hashes. */
  mac(...parts: string[]): string;
  /**
   * Key for signing cookies (Koa `app.keys`). Derived separately, so the raw SESSION_KEY is never
   * used for two purposes.
   */
  readonly cookieKey: string;
}

/** SESSION_KEY format check: canonical base64 of exactly 32 bytes, and not all zeros. */
export function isValidSessionKey(value: string): boolean {
  if (!BASE64_KEY_32.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 32 && bytes.some((b) => b !== 0);
}

/**
 * Builds a Cipher from SESSION_KEY (32 random bytes, base64). Separate subkeys for encryption,
 * hashing and cookie signing are derived with HKDF.
 */
export function createCipher(sessionKeyBase64: string): Cipher {
  if (!isValidSessionKey(sessionKeyBase64)) {
    throw new Error('SESSION_KEY must be 32 random bytes in base64 (44 characters)');
  }
  const master = Buffer.from(sessionKeyBase64, 'base64');
  const subkey = (info: string) =>
    Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
  const encKey = subkey('carrier-docs/enc');
  const macKey = subkey('carrier-docs/mac');
  const cookieKey = subkey('carrier-docs/cookie').toString('base64url');

  return {
    cookieKey,

    encrypt(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', encKey, iv);
      if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${VERSION}.${Buffer.concat([iv, tag, body]).toString('base64url')}`;
    },

    decrypt(token, aad) {
      const parts = token.split('.');
      const [version, payload] = parts;
      if (parts.length !== 2 || version !== VERSION || !payload) {
        throw new Error('Unsupported ciphertext format');
      }
      const raw = Buffer.from(payload, 'base64url');
      if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('Ciphertext too short');
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const body = raw.subarray(IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', encKey, iv, { authTagLength: TAG_BYTES });
      if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },

    mac(...parts) {
      const h = createHmac('sha256', macKey);
      // Length-prefix each part so ("ab","c") and ("a","bc") never collide.
      for (const p of parts) h.update(`${Buffer.byteLength(p)}:${p};`);
      return h.digest('hex');
    },
  };
}
