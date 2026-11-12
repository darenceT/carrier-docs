import { describe, expect, it } from 'vitest';
import { MAX_SAMPLES, SessionMetrics, percentile } from '../../src/session/metrics.js';

const SESSIONS = { live: 0, slotsInUse: 0, waiting: 0 };

describe('SessionMetrics', () => {
  it('nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBeUndefined();
    expect(percentile([7], 95)).toBe(7);
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
  });

  it('summarizes per carrier, with no carriers before the first login', () => {
    const m = new SessionMetrics(new Date('2026-11-11T00:00:00Z'));
    expect(m.snapshot(SESSIONS)).toEqual({
      since: '2026-11-11T00:00:00.000Z',
      sessions: SESSIONS,
      carriers: {},
    });
    m.record({
      carrierId: 'a',
      outcome: 'done',
      firstDocumentMs: 1000,
      fastPath: false,
      prewarmed: true,
    });
    m.record({
      carrierId: 'a',
      outcome: 'done',
      firstDocumentMs: 3000,
      fastPath: false,
      prewarmed: false,
    });
    m.record({
      carrierId: 'a',
      outcome: 'done',
      firstDocumentMs: 400,
      fastPath: true,
      prewarmed: false,
    });
    m.record({ carrierId: 'a', outcome: 'CARRIER_CHALLENGE', fastPath: false, prewarmed: false });
    m.record({ carrierId: 'b', outcome: 'BUSY', fastPath: false, prewarmed: false });
    const { carriers } = m.snapshot(SESSIONS);
    expect(carriers.a).toEqual({
      attempts: 4,
      outcomes: { done: 3, CARRIER_CHALLENGE: 1 },
      blockRate: 0.25,
      timeToFirstDocument: {
        all: { count: 3, p50: 1000, p95: 3000 },
        fullLogin: { count: 2, p50: 1000, p95: 3000 },
        fastPath: { count: 1, p50: 400, p95: 400 },
        prewarmed: { count: 1, p50: 1000, p95: 1000 },
        notPrewarmed: { count: 1, p50: 3000, p95: 3000 },
      },
    });
    expect(carriers.b).toMatchObject({
      attempts: 1,
      blockRate: 0,
      timeToFirstDocument: { all: { count: 0 } },
    });
  });

  it('keeps only the most recent samples', () => {
    const m = new SessionMetrics();
    for (let i = 0; i < MAX_SAMPLES + 10; i += 1) {
      m.record({
        carrierId: 'a',
        outcome: 'done',
        firstDocumentMs: i,
        fastPath: false,
        prewarmed: false,
      });
    }
    const a = m.snapshot(SESSIONS).carriers.a!;
    expect(a.attempts).toBe(MAX_SAMPLES + 10);
    expect(a.timeToFirstDocument.all.count).toBe(MAX_SAMPLES);
  });
});
