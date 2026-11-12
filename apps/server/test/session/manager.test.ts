import type { CarrierInfo, DocumentMeta, SessionEvent } from '@carrier-docs/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFingerprint, refreshFingerprint } from '../../src/antibot/fingerprint.js';
import { AppError } from '../../src/core/errors.js';
import type { CarrierAdapter, Credentials, LoginOutcome } from '../../src/core/ports.js';
import { MemorySessionStore } from '../../src/store/memory-store.js';
import {
  SessionManager,
  type CarrierBrowser,
  type ContextLike,
  type SessionLimits,
} from '../../src/session/manager.js';
import { SessionMetrics } from '../../src/session/metrics.js';
import { captureLogger } from '../browser/fakes.js';

// ---------- fakes: a scripted carrier and a browser that only counts contexts ----------

interface FakePage {
  id: number;
  /** Who this page is logged in as, if anyone. */
  user?: string;
  storage?: { user: string };
  closed: boolean;
}

const DOCS: DocumentMeta[] = [
  { id: 'card', title: 'ID card', kind: 'id_card', mimeType: 'application/pdf' },
  { id: 'dec', title: 'Declarations', kind: 'declarations', mimeType: 'application/pdf' },
];

const CODE = '123456';

/** Scripted by username: "nomfa", "wrong", "blocked", "empty" (no documents), else MFA. */
class FakeCarrier implements CarrierAdapter<FakePage> {
  readonly info: CarrierInfo = {
    id: 'demo',
    name: 'Demo',
    isDemo: true,
    loginFields: ['username', 'password'],
  };
  logins = 0;
  opened = 0;
  /** Saved sessions the "carrier" still accepts. */
  readonly validSessions = new Set<string>();
  /** Hold logins until released, to test concurrency. */
  gate?: Promise<void>;
  private pending = new Map<number, string>();

  async openLogin(): Promise<void> {
    this.opened += 1;
  }

  async login(page: FakePage, c: Credentials): Promise<LoginOutcome> {
    this.logins += 1;
    await this.gate;
    const user = c.username!;
    if (user === 'wrong') return { kind: 'failed', code: 'BAD_CREDENTIALS' };
    if (user === 'blocked') return { kind: 'failed', code: 'CARRIER_BLOCKED' };
    if (user === 'nomfa' || user === 'empty' || page.storage?.user === user) {
      page.user = user;
      return { kind: 'ok' };
    }
    this.pending.set(page.id, user);
    return { kind: 'mfa_required', hint: 'Code sent by text' };
  }

  async submitMfa(page: FakePage, code: string): Promise<LoginOutcome> {
    if (code !== CODE) return { kind: 'mfa_required', rejected: true };
    page.user = this.pending.get(page.id);
    return { kind: 'ok' };
  }

  async isSessionValid(page: FakePage): Promise<boolean> {
    const user = page.storage?.user;
    if (user && this.validSessions.has(user)) page.user = user;
    return page.user !== undefined;
  }

  async listDocuments(page: FakePage): Promise<DocumentMeta[]> {
    if (!page.user) throw new AppError('SESSION_EXPIRED');
    return page.user === 'empty' ? [] : DOCS;
  }

  async fetchDocument(page: FakePage, id: string) {
    if (page.closed) throw new AppError('CARRIER_UNAVAILABLE');
    // Saved cookies the carrier still accepts work without a session check, as on a real portal.
    const saved = page.storage?.user;
    if (!page.user && saved && this.validSessions.has(saved)) page.user = saved;
    if (!page.user) throw new AppError('SESSION_EXPIRED');
    return {
      mimeType: 'application/pdf',
      filename: `${id}.pdf`,
      body: new TextEncoder().encode(id),
    };
  }
}

class FakeBrowser implements CarrierBrowser<FakePage> {
  open = 0;
  created = 0;
  failNext = false;
  async browserVersion() {
    return '141.0.1.2';
  }
  proxy() {
    return undefined;
  }
  async newContext(options: { storageState?: unknown }): Promise<ContextLike<FakePage>> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('launch failed');
    }
    this.open += 1;
    this.created += 1;
    const page: FakePage = { id: this.created, closed: false };
    if (options.storageState) page.storage = options.storageState as { user: string };
    let closed = false;
    return {
      newPage: async () => page,
      storageState: async () => ({ user: page.user }),
      close: async () => {
        if (!closed) {
          closed = true;
          page.closed = true;
          this.open -= 1;
        }
      },
    };
  }
}

const LIMITS: SessionLimits = {
  maxSessions: 1,
  queueWaitMs: 30_000,
  maxQueue: 2,
  mfaTimeoutMs: 300_000,
  prewarmTimeoutMs: 120_000,
  sessionTtlMs: 7 * 24 * 3_600_000,
  documentCacheMs: 600_000,
};

const clock = { now: () => Date.now() };
let carrier: FakeCarrier;
let browser: FakeBrowser;
let store: MemorySessionStore;
let manager: SessionManager<FakePage>;
let metrics: SessionMetrics;

function makeManager(limits: Partial<SessionLimits> = {}) {
  carrier = new FakeCarrier();
  browser = new FakeBrowser();
  store = new MemorySessionStore(clock);
  metrics = new SessionMetrics();
  manager = new SessionManager<FakePage>({
    metrics,
    adapters: [carrier],
    browserFor: () => browser,
    store,
    clock,
    logger: captureLogger().logger,
    mac: (...parts) => parts.join('|'),
    createFingerprint,
    refreshFingerprint,
    limits: { ...LIMITS, ...limits },
  });
}

/** Start a login and collect its events. */
async function login(owner: string, username: string, extra: { prewarmSessionId?: string } = {}) {
  const { sessionId } = await manager.start(owner, {
    carrierId: 'demo',
    username,
    password: 'pw',
    ...extra,
  });
  const events: SessionEvent[] = [];
  manager.subscribe(owner, sessionId, (e) => events.push(e));
  return { sessionId, events };
}

/** Status changes, without the 'idle' a subscriber sees if it connects before the flow starts. */
const statuses = (events: SessionEvent[]) =>
  events.flatMap((e) => (e.type === 'status' && e.status !== 'idle' ? [e.status] : []));
const last = (events: SessionEvent[]) => events[events.length - 1];
/** Let queued promise callbacks run (fake timers don't advance microtasks on their own). */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  makeManager();
});

afterEach(async () => {
  await manager.close();
  vi.useRealTimers();
});

describe('SessionManager: login flows', () => {
  it('MFA path: login, code, documents (ID card first), done, and the slot is freed', async () => {
    const { sessionId, events } = await login('o1', 'alice');
    await settle();
    expect(last(events)).toEqual({
      type: 'mfa_required',
      hint: 'Code sent by text',
      attemptsLeft: 3,
      lastAttemptRejected: false,
    });
    await manager.submitMfa('o1', sessionId, CODE);
    await settle();
    expect(statuses(events)).toEqual([
      'logging_in',
      'mfa_required',
      'verifying_mfa',
      'fetching_docs',
      'document_ready',
      'done',
    ]);
    expect(events.find((e) => e.type === 'documents_listed')).toEqual({
      type: 'documents_listed',
      documents: DOCS,
    });
    expect(events.find((e) => e.type === 'document_ready')).toMatchObject({ documentId: 'card' });
    expect(last(events)).toEqual({ type: 'done' });
    expect(browser.open).toBe(0);
    expect(manager.stats().slotsInUse).toBe(0);
  });

  it('attaches per-step timings to status events', async () => {
    const { sessionId, events } = await login('o1', 'alice');
    await settle();
    await vi.advanceTimersByTimeAsync(4_000); // the user reads their phone
    await manager.submitMfa('o1', sessionId, CODE);
    await settle();
    const final = events.filter((e) => e.type === 'status').pop();
    expect(final).toMatchObject({ status: 'done' });
    const steps = final?.type === 'status' ? final.timings : [];
    expect(steps.map((t) => t.step)).toEqual([
      'logging_in',
      'mfa_required',
      'verifying_mfa',
      'fetching_docs',
      'document_ready',
    ]);
    expect(steps.find((t) => t.step === 'mfa_required')?.ms).toBe(4_000);
  });

  it('no-MFA path goes straight to documents', async () => {
    const { events } = await login('o1', 'nomfa');
    await settle();
    expect(statuses(events)).toEqual(['logging_in', 'fetching_docs', 'document_ready', 'done']);
  });

  it('serves the first document and the prefetched rest from memory after the browser closed', async () => {
    const { sessionId } = await login('o1', 'nomfa');
    await settle();
    expect(browser.open).toBe(0);
    for (const id of ['card', 'dec']) {
      const doc = await manager.getDocument('o1', sessionId, id);
      expect(new TextDecoder().decode(doc.body as Uint8Array)).toBe(id);
    }
    await expect(manager.getDocument('o1', sessionId, 'nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('after the cache expires the session is gone (NOT_FOUND)', async () => {
    const { sessionId } = await login('o1', 'nomfa');
    await settle();
    await vi.advanceTimersByTimeAsync(LIMITS.documentCacheMs + 1);
    await expect(manager.getDocument('o1', sessionId, 'card')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('wrong code: retries with attemptsLeft, then fails MFA_INVALID after 3', async () => {
    const { sessionId, events } = await login('o1', 'alice');
    await settle();
    for (let i = 0; i < 2; i++) {
      await manager.submitMfa('o1', sessionId, '000000');
      await settle();
    }
    expect(last(events)).toMatchObject({
      type: 'mfa_required',
      attemptsLeft: 1,
      lastAttemptRejected: true,
    });
    await manager.submitMfa('o1', sessionId, '000000');
    await settle();
    expect(last(events)).toMatchObject({ type: 'failed', code: 'MFA_INVALID', retryable: false });
    expect(browser.open).toBe(0);
  });

  it('no code within the MFA timeout fails MFA_TIMEOUT and frees the slot', async () => {
    const { events } = await login('o1', 'alice');
    await settle();
    await vi.advanceTimersByTimeAsync(LIMITS.mfaTimeoutMs);
    expect(last(events)).toMatchObject({ type: 'failed', code: 'MFA_TIMEOUT' });
    expect(manager.stats().slotsInUse).toBe(0);
  });

  it.each([
    ['wrong', 'BAD_CREDENTIALS'],
    ['blocked', 'CARRIER_BLOCKED'],
  ])('carrier outcome %s fails with %s', async (username, code) => {
    const { events } = await login('o1', username);
    await settle();
    expect(last(events)).toMatchObject({ type: 'failed', code });
    expect(browser.open).toBe(0);
  });

  it('a browser that will not start fails INTERNAL without leaking the slot', async () => {
    browser.failNext = true;
    const { events } = await login('o1', 'alice');
    await settle();
    expect(last(events)).toMatchObject({ type: 'failed', code: 'INTERNAL' });
    expect(manager.stats().slotsInUse).toBe(0);
  });

  it('an account with no documents is done, not failed', async () => {
    const { events } = await login('o1', 'empty');
    await settle();
    expect(last(events)).toEqual({ type: 'done' });
  });

  it('rejects MFA when not waiting for a code', async () => {
    const { sessionId } = await login('o1', 'nomfa');
    await settle();
    await expect(manager.submitMfa('o1', sessionId, CODE)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('a late subscriber is caught up: status, documents, ready, done', async () => {
    const { sessionId } = await login('o1', 'nomfa');
    await settle();
    const replay: SessionEvent[] = [];
    manager.subscribe('o1', sessionId, (e) => replay.push(e));
    expect(replay.map((e) => e.type)).toEqual([
      'status',
      'documents_listed',
      'document_ready',
      'done',
    ]);
  });
});

describe('SessionManager: saved sessions (fast path)', () => {
  it('a repeat run skips login and MFA', async () => {
    const first = await login('o1', 'alice');
    await settle();
    await manager.submitMfa('o1', first.sessionId, CODE);
    await settle();
    carrier.validSessions.add('alice');
    const logins = carrier.logins;

    const repeat = await login('o1', 'alice');
    await settle();
    expect(statuses(repeat.events)).toEqual([
      'checking_session',
      'fetching_docs',
      'document_ready',
      'done',
    ]);
    expect(carrier.logins).toBe(logins);
  });

  it('a rejected saved session falls back to a full login and is replaced', async () => {
    const first = await login('o1', 'alice');
    await settle();
    await manager.submitMfa('o1', first.sessionId, CODE);
    await settle();
    // The carrier no longer accepts it, but the device is still trusted: no MFA.
    const repeat = await login('o1', 'alice');
    await settle();
    expect(statuses(repeat.events)).toEqual([
      'checking_session',
      'logging_in',
      'fetching_docs',
      'document_ready',
      'done',
    ]);
    expect(await store.get('reuse|o1|demo|alice')).toBeDefined();
  });

  it('the reuse key needs the same browser: another owner logs in fully', async () => {
    const first = await login('o1', 'alice');
    await settle();
    await manager.submitMfa('o1', first.sessionId, CODE);
    await settle();
    carrier.validSessions.add('alice');
    const other = await login('o2', 'alice');
    await settle();
    expect(statuses(other.events)[0]).toBe('logging_in');
  });

  it('saves storage and the device profile, never the password', async () => {
    await login('o1', 'nomfa');
    await settle();
    const saved = await store.get('reuse|o1|demo|nomfa');
    expect(saved).toMatchObject({ carrierId: 'demo', storageState: { user: 'nomfa' } });
    expect(saved?.fingerprint.timezoneId).toBe('America/Los_Angeles');
    expect(JSON.stringify(saved)).not.toContain('pw');
  });

  it('reopens from the saved session for a document the cache no longer has', async () => {
    const { sessionId } = await login('o1', 'nomfa');
    await settle();
    carrier.validSessions.add('nomfa');
    // Simulate a prefetch miss.
    (manager as unknown as { sessions: Map<string, { cache: Map<string, unknown> }> }).sessions
      .get(sessionId)!
      .cache.delete('dec');
    const created = browser.created;
    const doc = await manager.getDocument('o1', sessionId, 'dec');
    expect(new TextDecoder().decode(doc.body as Uint8Array)).toBe('dec');
    expect(browser.created).toBe(created + 1);
    expect(browser.open).toBe(0);
  });
});

describe('SessionManager: pre-warm', () => {
  it('a login adopts its pre-warmed page and slot', async () => {
    const { sessionId: pw } = await manager.prewarm('o1', 'demo');
    await settle();
    expect(carrier.opened).toBe(1);
    expect(manager.stats().slotsInUse).toBe(1);
    const created = browser.created;
    const { events } = await login('o1', 'nomfa', { prewarmSessionId: pw });
    await settle();
    expect(last(events)).toEqual({ type: 'done' });
    expect(browser.created).toBe(created); // no second context
  });

  it('closes quietly after the pre-warm timeout', async () => {
    await manager.prewarm('o1', 'demo');
    await settle();
    await vi.advanceTimersByTimeAsync(LIMITS.prewarmTimeoutMs);
    expect(manager.stats()).toMatchObject({ live: 0, slotsInUse: 0 });
    expect(browser.open).toBe(0);
  });

  it('one unused pre-warm per owner: a new pick replaces the old', async () => {
    makeManager({ maxSessions: 2 });
    await manager.prewarm('o1', 'demo');
    await manager.prewarm('o1', 'demo');
    await settle();
    expect(manager.stats().slotsInUse).toBe(1);
    expect(browser.open).toBe(1);
  });

  it("ignores another owner's, an unknown, or an expired pre-warm ID: fresh login", async () => {
    makeManager({ maxSessions: 2 });
    const { sessionId: theirs } = await manager.prewarm('o2', 'demo');
    for (const id of [theirs, 'nope']) {
      const { events } = await login('o1', 'nomfa', { prewarmSessionId: id });
      await settle();
      expect(last(events)).toEqual({ type: 'done' });
    }
    // o2's pre-warm is untouched.
    expect(manager.stats().slotsInUse).toBe(1);
  });

  it('a returning user does not use the pre-warm page (saved profile instead)', async () => {
    makeManager({ maxSessions: 1 });
    await login('o1', 'nomfa');
    await settle();
    carrier.validSessions.add('nomfa');
    const { sessionId: pw } = await manager.prewarm('o1', 'demo');
    await settle();
    const { events } = await login('o1', 'nomfa', { prewarmSessionId: pw });
    await settle();
    expect(statuses(events)[0]).toBe('checking_session');
    expect(last(events)).toEqual({ type: 'done' });
    expect(browser.open).toBe(0);
  });

  it('a failed pre-warm is harmless: the login opens its own page', async () => {
    browser.failNext = true;
    const { sessionId: pw } = await manager.prewarm('o1', 'demo');
    await settle();
    const { events } = await login('o1', 'nomfa', { prewarmSessionId: pw });
    await settle();
    expect(last(events)).toEqual({ type: 'done' });
  });

  it('pre-warm sessions are not visible as sessions', async () => {
    const { sessionId: pw } = await manager.prewarm('o1', 'demo');
    expect(() => manager.subscribe('o1', pw, () => undefined)).toThrow(AppError);
  });
});

describe('SessionManager: capacity', () => {
  it('a login evicts an unused pre-warm instead of waiting', async () => {
    await manager.prewarm('o2', 'demo');
    await settle();
    const { events } = await login('o1', 'nomfa');
    await settle();
    expect(statuses(events)[0]).toBe('logging_in');
    expect(last(events)).toEqual({ type: 'done' });
  });

  it('waits in line while the slot is busy, then runs when it frees', async () => {
    const first = await login('o1', 'alice'); // holds the slot at MFA
    await settle();
    const second = await login('o2', 'nomfa');
    await settle();
    expect(statuses(second.events)).toEqual(['queued']);
    expect(manager.stats().waiting).toBe(1);

    await manager.submitMfa('o1', first.sessionId, CODE);
    await settle();
    expect(statuses(second.events)).toEqual([
      'queued',
      'logging_in',
      'fetching_docs',
      'document_ready',
      'done',
    ]);
  });

  it('a queued login fails BUSY (retryable) when the wait runs out', async () => {
    await login('o1', 'alice');
    await settle();
    const second = await login('o2', 'nomfa');
    await vi.advanceTimersByTimeAsync(LIMITS.queueWaitMs);
    expect(last(second.events)).toMatchObject({ type: 'failed', code: 'BUSY', retryable: true });
    expect(manager.stats().waiting).toBe(0);
  });

  it('BUSY right away when the line is full', async () => {
    await login('o1', 'alice');
    await login('o2', 'nomfa');
    await login('o3', 'nomfa');
    await expect(login('o4', 'nomfa')).rejects.toMatchObject({ code: 'BUSY' });
  });

  it('serves the line first in, first out', async () => {
    makeManager({ maxSessions: 1, maxQueue: 3 });
    const first = await login('o1', 'alice');
    const b = await login('o2', 'nomfa');
    const c = await login('o3', 'nomfa');
    await settle();
    await manager.submitMfa('o1', first.sessionId, CODE);
    await settle();
    expect(last(b.events)).toEqual({ type: 'done' });
    expect(last(c.events)).toEqual({ type: 'done' });
    const doneAt = (e: SessionEvent[]) => e.findIndex((x) => x.type === 'done');
    expect(doneAt(b.events)).toBeGreaterThan(-1);
  });

  it('two simultaneous logins never share the last slot', async () => {
    let release!: () => void;
    carrier.gate = new Promise<void>((r) => (release = r));
    const [a, b] = await Promise.all([login('o1', 'nomfa'), login('o2', 'nomfa')]);
    await settle();
    expect(manager.stats().slotsInUse).toBe(1);
    expect([statuses(a.events)[0], statuses(b.events)[0]].sort()).toEqual(['logging_in', 'queued']);
    release();
    await settle();
    expect(last(a.events)).toEqual({ type: 'done' });
    expect(last(b.events)).toEqual({ type: 'done' });
  });

  it('a pre-warm never takes the slot from a waiting login', async () => {
    await login('o1', 'alice');
    await login('o2', 'nomfa');
    await expect(manager.prewarm('o3', 'demo')).rejects.toMatchObject({ code: 'BUSY' });
  });
});

describe('SessionManager: ownership, validation, forget', () => {
  it("another owner's session ID is NOT_FOUND everywhere", async () => {
    const { sessionId } = await login('o1', 'alice');
    await settle();
    expect(() => manager.subscribe('o2', sessionId, () => undefined)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    await expect(manager.submitMfa('o2', sessionId, CODE)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(manager.getDocument('o2', sessionId, 'card')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects unknown carriers and missing login fields', async () => {
    await expect(manager.prewarm('o1', 'nope')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      manager.start('o1', { carrierId: 'nope', username: 'a', password: 'b' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(manager.start('o1', { carrierId: 'demo', username: 'a' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('lists the adapters as carriers', () => {
    expect(manager.listCarriers()).toEqual([carrier.info]);
  });

  it('"Forget me" ends live sessions and deletes saved ones', async () => {
    await login('o1', 'nomfa');
    await settle();
    const live = await login('o1', 'alice');
    await settle();
    expect(await manager.forget('o1')).toBe(1); // one saved session; the MFA one wasn't saved yet
    expect(last(live.events)).toMatchObject({ type: 'failed', code: 'SESSION_EXPIRED' });
    expect(manager.stats()).toMatchObject({ live: 0, slotsInUse: 0 });
    await settle();
    expect(browser.open).toBe(0);
  });
});

describe('SessionManager: metrics for /api/status', () => {
  const demo = () => metrics.snapshot(manager.stats()).carriers.demo!;

  it('records a full login once, excluding the time the user took to type the code', async () => {
    const { sessionId } = await login('o1', 'alice');
    await settle();
    await vi.advanceTimersByTimeAsync(20_000); // reading the text message
    await manager.submitMfa('o1', sessionId, CODE);
    await settle();
    await vi.advanceTimersByTimeAsync(LIMITS.documentCacheMs);
    const d = demo();
    expect(d.attempts).toBe(1);
    expect(d.outcomes).toEqual({ done: 1 });
    expect(d.timeToFirstDocument.fullLogin).toMatchObject({ count: 1 });
    expect(d.timeToFirstDocument.fullLogin.p50).toBeLessThan(1_000);
    expect(d.timeToFirstDocument.fastPath.count).toBe(0);
    expect(d.timeToFirstDocument.notPrewarmed.count).toBe(1);
  });

  it('splits the fast path and pre-warmed logins', async () => {
    await login('o1', 'nomfa');
    await settle();
    carrier.validSessions.add('nomfa');
    await login('o1', 'nomfa'); // saved session accepted
    await settle();
    const { sessionId: pw } = await manager.prewarm('o2', 'demo');
    await settle();
    await login('o2', 'nomfa', { prewarmSessionId: pw }); // another owner: no saved session
    await settle();
    const t = demo().timeToFirstDocument;
    expect(t.all.count).toBe(3);
    expect(t.fastPath.count).toBe(1);
    expect(t.fullLogin.count).toBe(2);
    expect(t.prewarmed.count).toBe(1);
    expect(t.notPrewarmed.count).toBe(1);
  });

  it('counts failures by code, the block rate, and never a pre-warm', async () => {
    for (const user of ['wrong', 'blocked', 'nomfa', 'nomfa']) {
      await login('o1', user);
      await settle();
    }
    await manager.prewarm('o3', 'demo');
    await vi.advanceTimersByTimeAsync(LIMITS.prewarmTimeoutMs);
    const d = demo();
    expect(d.attempts).toBe(4);
    expect(d.outcomes).toEqual({ BAD_CREDENTIALS: 1, CARRIER_BLOCKED: 1, done: 2 });
    expect(d.blockRate).toBe(0.25);
    expect(d.timeToFirstDocument.all.count).toBe(2);
  });

  it('a third wrong code counts once, as MFA_INVALID', async () => {
    const { sessionId } = await login('o1', 'alice');
    await settle();
    for (let i = 0; i < 3; i += 1) {
      await manager.submitMfa('o1', sessionId, '000000');
      await settle();
    }
    expect(demo().outcomes).toEqual({ MFA_INVALID: 1 });
  });
});
