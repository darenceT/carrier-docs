import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCipher } from '../../src/infra/crypto.js';

const key = () => randomBytes(32).toString('base64');

describe('createCipher', () => {
  it('round-trips text', () => {
    const c = createCipher(key());
    const plain = JSON.stringify({ cookies: [{ name: 'sid', value: 'abc' }] });
    expect(c.decrypt(c.encrypt(plain))).toBe(plain);
  });

  it('uses a fresh IV every time', () => {
    const c = createCipher(key());
    expect(c.encrypt('same')).not.toBe(c.encrypt('same'));
  });

  it('does not contain the plaintext', () => {
    const c = createCipher(key());
    expect(c.encrypt('secret-cookie-value')).not.toContain('secret-cookie-value');
  });

  it('detects tampering', () => {
    const c = createCipher(key());
    const token = c.encrypt('hello');
    const raw = Buffer.from(token.slice(3), 'base64url');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(() => c.decrypt(`v1.${raw.toString('base64url')}`)).toThrow();
  });

  it('cannot decrypt with a different key', () => {
    const token = createCipher(key()).encrypt('hello');
    expect(() => createCipher(key()).decrypt(token)).toThrow();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => createCipher(randomBytes(16).toString('base64'))).toThrow(/32 random bytes/);
    expect(() => createCipher('REPLACE_WITH_32_RANDOM_BYTES_BASE64')).toThrow(/32 random bytes/);
    expect(() => createCipher('!!!!' + key())).toThrow(/32 random bytes/);
    expect(() => createCipher(Buffer.alloc(32).toString('base64'))).toThrow(/32 random bytes/);
  });

  it('rejects unknown formats', () => {
    expect(() => createCipher(key()).decrypt('v9.abc')).toThrow(/format/);
  });

  it('mac is deterministic per key and unambiguous across parts', () => {
    const k = key();
    const a = createCipher(k);
    expect(a.mac('owner', 'progressive', 'user')).toBe(
      createCipher(k).mac('owner', 'progressive', 'user'),
    );
    expect(a.mac('ab', 'c')).not.toBe(a.mac('a', 'bc'));
    expect(a.mac('x')).not.toBe(createCipher(key()).mac('x'));
  });

  it('binds ciphertext to its associated data', () => {
    const c = createCipher(key());
    const token = c.encrypt('session-for-a', 'row-a');
    expect(c.decrypt(token, 'row-a')).toBe('session-for-a');
    expect(() => c.decrypt(token, 'row-b')).toThrow();
    expect(() => c.decrypt(token)).toThrow();
  });

  it('rejects tokens with extra segments', () => {
    const c = createCipher(key());
    expect(() => c.decrypt(`${c.encrypt('x')}.junk`)).toThrow(/format/);
  });

  it('derives a cookie key distinct from the raw key and stable per key', () => {
    const k = key();
    const a = createCipher(k);
    expect(a.cookieKey).toBe(createCipher(k).cookieKey);
    expect(a.cookieKey).not.toBe(createCipher(key()).cookieKey);
    expect(a.cookieKey).not.toContain(k);
    expect(Buffer.from(a.cookieKey, 'base64url')).toHaveLength(32);
  });
});
