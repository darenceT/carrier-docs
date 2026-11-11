import { describe, expect, it } from 'vitest';
import { baseDomain, within } from '../../src/scripts/live/fields.js';

describe('within', () => {
  it('returns the value when the promise settles in time', async () => {
    await expect(within(Promise.resolve(true), 50, false)).resolves.toBe(true);
  });

  it('returns the fallback when the promise hangs', async () => {
    const never = new Promise<boolean>(() => {});
    await expect(within(never, 20, false)).resolves.toBe(false);
  });

  it('returns the fallback when the promise rejects', async () => {
    await expect(within(Promise.reject(new Error('detached')), 50, false)).resolves.toBe(false);
  });
});

describe('baseDomain', () => {
  it('keeps the last two labels of the hostname', () => {
    expect(baseDomain('https://account.apps.progressive.com/access/login?x=1')).toBe(
      'progressive.com',
    );
    expect(baseDomain('https://www.lemonade.com/login#email')).toBe('lemonade.com');
    expect(baseDomain('https://trc.taboola.com/x')).toBe('taboola.com');
    expect(baseDomain('about:blank')).toBe('');
  });
});
