import type { CarrierStatus, LatencySummary, StatusResponse } from '@carrier-docs/contracts';
import type { ErrorCode } from '../core/errors.js';

/** One login that reached an outcome. No user data: carrier, outcome and timings only. */
export interface LoginRecord {
  carrierId: string;
  outcome: 'done' | ErrorCode;
  /** Present when a document arrived; excludes the time spent waiting for the user's code. */
  firstDocumentMs?: number;
  /** The saved session was accepted: no login or MFA. */
  fastPath: boolean;
  /** A pre-warmed login page was taken over. */
  prewarmed: boolean;
}

const BLOCK_CODES: ReadonlySet<string> = new Set(['CARRIER_BLOCKED', 'CARRIER_CHALLENGE']);

/** Latency samples kept per carrier: enough for stable percentiles, bounded memory. */
export const MAX_SAMPLES = 500;

interface Sample {
  ms: number;
  fastPath: boolean;
  prewarmed: boolean;
}

interface CarrierCounters {
  attempts: number;
  outcomes: Map<string, number>;
  samples: Sample[];
}

/** Nearest-rank percentile of sorted values. */
export function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function summarize(samples: Sample[]): LatencySummary {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const summary: LatencySummary = { count: sorted.length };
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  if (p50 !== undefined) summary.p50 = Math.round(p50);
  if (p95 !== undefined) summary.p95 = Math.round(p95);
  return summary;
}

/**
 * In-memory counters for GET /api/status (design: Observability). They reset when the process
 * restarts; Render's logs keep the per-session lines for anything longer.
 */
export class SessionMetrics {
  private readonly carriers = new Map<string, CarrierCounters>();
  readonly since: Date;

  constructor(now: Date = new Date()) {
    this.since = now;
  }

  record(r: LoginRecord): void {
    let c = this.carriers.get(r.carrierId);
    if (!c) {
      c = { attempts: 0, outcomes: new Map(), samples: [] };
      this.carriers.set(r.carrierId, c);
    }
    c.attempts += 1;
    c.outcomes.set(r.outcome, (c.outcomes.get(r.outcome) ?? 0) + 1);
    if (r.firstDocumentMs !== undefined) {
      c.samples.push({ ms: r.firstDocumentMs, fastPath: r.fastPath, prewarmed: r.prewarmed });
      if (c.samples.length > MAX_SAMPLES) c.samples.shift();
    }
  }

  snapshot(sessions: StatusResponse['sessions']): StatusResponse {
    const carriers: Record<string, CarrierStatus> = {};
    for (const [id, c] of this.carriers) {
      let blocked = 0;
      for (const [outcome, n] of c.outcomes) if (BLOCK_CODES.has(outcome)) blocked += n;
      carriers[id] = {
        attempts: c.attempts,
        outcomes: Object.fromEntries(c.outcomes),
        blockRate: c.attempts === 0 ? 0 : blocked / c.attempts,
        timeToFirstDocument: {
          all: summarize(c.samples),
          fullLogin: summarize(c.samples.filter((s) => !s.fastPath)),
          fastPath: summarize(c.samples.filter((s) => s.fastPath)),
          prewarmed: summarize(c.samples.filter((s) => s.prewarmed)),
          notPrewarmed: summarize(c.samples.filter((s) => !s.prewarmed && !s.fastPath)),
        },
      };
    }
    return { since: this.since.toISOString(), sessions, carriers };
  }
}
