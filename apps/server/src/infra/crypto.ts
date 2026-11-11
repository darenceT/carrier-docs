import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12; // GCM standard nonce size
const TAG_BYTES = 16;

export interface Cipher {
  /** AES-256-GCM with a random IV per call. Output: "v1.<base64url(iv | tag | ciphertext)>". */
  encrypt(plaintext: string): string;
  /** Throws if the token was tampered with or made with a different key. */
  decrypt(token: string): string;
  /** Keyed, deterministic hash (HMAC-SHA256, hex). Used for reuse keys and username hashes. */
  mac(...parts: string[]): string;
}

/**
 * Builds a Cipher from SESSION_KEY (32 random bytes, base64). Separate subkeys for encryption and
 * hashing are derived with HKDF, so the raw key is never used for two purposes.
 */
export function createCipher(sessionKeyBase64: string): Cipher {
  const master = Buffer.from(sessionKeyBase64, 'base64');
  if (master.length !== 32) {
    throw new Error(`SESSION_KEY must decode to 32 bytes (got ${master.length})`);
  }
  const encKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'carrier-docs/enc', 32));
  const macKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'carrier-docs/mac', 32));

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', encKey, iv);
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${VERSION}.${Buffer.concat([iv, tag, body]).toString('base64url')}`;
    },

    decrypt(token) {
      const [version, payload] = token.split('.', 2);
      if (version !== VERSION || !payload) throw new Error('Unsupported ciphertext format');
      const raw = Buffer.from(payload, 'base64url');
      if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('Ciphertext too short');
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const body = raw.subarray(IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
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
