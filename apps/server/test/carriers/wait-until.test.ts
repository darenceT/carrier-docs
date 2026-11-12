import { describe, expect, it } from 'vitest';
import { Signal, waitUntil } from '../../src/carriers/shared.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** A tick that never comes: only a signal can end the wait. */
const never = () => new Promise<void>(() => undefined);

describe('Signal', () => {
  it('wakes everyone waiting, once', async () => {
    const signal = new Signal();
    let woken = 0;
    void signal.next().promise.then(() => woken++);
    void signal.next().promise.then(() => woken++);
    signal.notify();
    signal.notify();
    await flush();
    expect(woken).toBe(2);
  });

  it('does not wake a cancelled waiter', async () => {
    const signal = new Signal();
    let woken = false;
    const waiter = signal.next();
    void waiter.promise.then(() => (woken = true));
    waiter.cancel();
    signal.notify();
    await flush();
    expect(woken).toBe(false);
  });
});

describe('waitUntil', () => {
  it('returns at once when the value is already there', async () => {
    const signal = new Signal();
    expect(await waitUntil(() => 'ready', { signal, tick: never, timeoutMs: 1000 })).toBe('ready');
  });

  it('re-checks on a signal, without waiting for the next tick', async () => {
    const signal = new Signal();
    const state: { value?: string } = {};
    const result = waitUntil(() => state.value, { signal, tick: never, timeoutMs: 60_000 });
    await flush();
    state.value = 'arrived';
    signal.notify();
    expect(await result).toBe('arrived');
  });

  it('does not miss a change that lands while an async check is running', async () => {
    const signal = new Signal();
    let value: string | undefined;
    let checks = 0;
    const result = waitUntil(
      async () => {
        const seen = value;
        checks += 1;
        if (checks === 1) {
          // The change and its signal arrive after this check sampled the state.
          value = 'arrived';
          signal.notify();
        }
        await flush();
        return seen;
      },
      { signal, tick: never, timeoutMs: 60_000 },
    );
    expect(await result).toBe('arrived');
    expect(checks).toBe(2);
  });

  it('re-checks on each tick, for conditions nothing signals', async () => {
    const signal = new Signal();
    let checks = 0;
    const result = await waitUntil(() => (++checks === 3 ? 'third' : undefined), {
      signal,
      tick: flush,
      timeoutMs: 60_000,
    });
    expect(result).toBe('third');
  });

  it('returns null at the deadline', async () => {
    let now = 0;
    const result = await waitUntil(() => undefined, {
      signal: new Signal(),
      tick: async () => {
        now += 200;
      },
      timeoutMs: 1000,
      now: () => now,
    });
    expect(result).toBeNull();
    expect(now).toBe(1000);
  });

  it('ends with the error when the check throws or the tick rejects (a closed page)', async () => {
    const signal = new Signal();
    await expect(
      waitUntil(
        () => {
          throw new Error('stop');
        },
        { signal, tick: never, timeoutMs: 1000 },
      ),
    ).rejects.toThrow('stop');
    await expect(
      waitUntil(() => undefined, {
        signal,
        tick: () => Promise.reject(new Error('page closed')),
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('page closed');
  });

  it('leaves no waiter behind', async () => {
    const signal = new Signal();
    await waitUntil(() => 'x', { signal, tick: never, timeoutMs: 1000 });
    let ticks = 0;
    await waitUntil(() => (ticks === 2 ? 'x' : undefined), {
      signal,
      tick: async () => {
        ticks += 1;
      },
      timeoutMs: 1000,
    });
    expect((signal as unknown as { waiters: Set<unknown> }).waiters.size).toBe(0);
  });
});
