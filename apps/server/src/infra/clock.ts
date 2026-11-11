import type { Clock } from '../core/ports.js';

export const systemClock: Clock = { now: () => Date.now() };

/** A clock tests can move by hand. */
export class ManualClock implements Clock {
  constructor(private current = 0) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
