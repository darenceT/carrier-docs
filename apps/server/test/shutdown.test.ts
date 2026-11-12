import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../src/shutdown.js';
import { captureLogger } from './browser/fakes.js';

function setup(overrides: { drain?: () => Promise<void>; close?: () => Promise<void> } = {}) {
  const steps: string[] = [];
  let closeCallback: (() => void) | undefined;
  const server = {
    close: (cb: () => void) => {
      steps.push('server.close');
      closeCallback = cb;
    },
    closeAllConnections: () => {
      steps.push('closeAllConnections');
      closeCallback?.();
    },
  };
  const services = {
    drain: vi.fn(async (ms: number) => {
      steps.push(`drain ${ms}`);
      await overrides.drain?.();
    }),
    close: vi.fn(async () => {
      steps.push('services.close');
      await overrides.close?.();
    }),
  };
  const exit = vi.fn((code: number) => steps.push(`exit ${code}`));
  const shutdown = createShutdown({
    server,
    services,
    logger: captureLogger().logger,
    drainMs: 25_000,
    hardStopMs: 29_000,
    exit,
  });
  return { shutdown, steps, exit, services };
}

describe('graceful shutdown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drains first, then closes connections, then services, then exits 0', async () => {
    const { shutdown, steps } = setup();
    await shutdown('SIGTERM');
    expect(steps).toEqual([
      'drain 25000',
      'server.close',
      'closeAllConnections',
      'services.close',
      'exit 0',
    ]);
  });

  it('keeps serving while draining: the server is not closed until the drain ends', async () => {
    let finishDrain!: () => void;
    const { shutdown, steps } = setup({ drain: () => new Promise((r) => (finishDrain = r)) });
    const done = shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(steps).toEqual(['drain 25000']);
    finishDrain();
    await done;
    expect(steps.at(-1)).toBe('exit 0');
  });

  it('ignores a second signal', async () => {
    const { shutdown, services, exit } = setup();
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(services.drain).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits 1 if a step fails, after still closing what it can', async () => {
    const { shutdown, steps } = setup({ drain: () => Promise.reject(new Error('boom')) });
    await shutdown('SIGTERM');
    expect(steps).toEqual([
      'drain 25000',
      'server.close',
      'closeAllConnections',
      'services.close',
      'exit 1',
    ]);
  });

  it('hard-stops with 1 if closing hangs', async () => {
    const { shutdown, exit } = setup({ close: () => new Promise(() => undefined) });
    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(28_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
