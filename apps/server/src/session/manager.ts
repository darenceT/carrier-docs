import { randomUUID } from 'node:crypto';
import type {
  CarrierInfo,
  DocumentMeta,
  SessionEvent as WireEvent,
  StartSessionRequest,
  StepTiming,
} from '@carrier-docs/contracts';
import type { Logger } from 'pino';
import { AppError, ERROR_INFO, isAppError, type ErrorCode } from '../core/errors.js';
import type {
  CarrierAdapter,
  Clock,
  Credentials,
  DocumentContent,
  FingerprintProfile,
  LoginOutcome,
  SessionService,
  SessionStore,
} from '../core/ports.js';
import {
  MAX_MFA_ATTEMPTS,
  canTransition,
  initialState,
  isTerminal,
  transition,
  type SessionEvent,
  type SessionState,
} from '../core/state-machine.js';
import type { SessionMetrics } from './metrics.js';
import { isBrowserGone } from '../browser/errors.js';

// ---------- what the manager needs from the browser side (structural, so tests can fake it) ----------

export interface ContextLike<Page> {
  newPage(): Promise<Page>;
  close(): Promise<void>;
  /** Cookies and storage to save. Secret: never logged. */
  storageState(): Promise<unknown>;
}

export interface CarrierBrowser<Page> {
  browserVersion(): Promise<string>;
  newContext(options: {
    fingerprint: FingerprintProfile;
    storageState?: unknown;
    proxy?: { server: string; username?: string; password?: string };
  }): Promise<ContextLike<Page>>;
  /** Egress proxy for new contexts, from the anti-bot layer. */
  proxy(): { server: string; username?: string; password?: string } | undefined;
}

export interface SessionManagerOptions<Page> {
  adapters: CarrierAdapter<Page>[];
  /** The browser for one carrier, as the anti-bot layer configures it. */
  browserFor(carrierId: string): CarrierBrowser<Page>;
  store: SessionStore;
  clock: Clock;
  logger: Logger;
  /** Keyed hash for the reuse key (cipher.mac): owner + carrier + login identifier. */
  mac(...parts: string[]): string;
  createFingerprint(browserVersion: string): FingerprintProfile;
  refreshFingerprint(saved: FingerprintProfile, browserVersion: string): FingerprintProfile;
  limits: SessionLimits;
  /** Outcome and latency counters for GET /api/status. */
  metrics?: SessionMetrics;
}

export interface SessionLimits {
  maxSessions: number;
  /** How long a login waits in line for a free slot. */
  queueWaitMs: number;
  /** At most this many logins wait in line; beyond that, BUSY right away. */
  maxQueue: number;
  mfaTimeoutMs: number;
  prewarmTimeoutMs: number;
  sessionTtlMs: number;
  /** Fetched documents stay in memory this long after the session ends. */
  documentCacheMs: number;
}

// ---------- internal session record ----------

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

interface Live<Page> {
  id: string;
  ownerId: string;
  carrierId: string;
  kind: 'prewarm' | 'login';
  state: SessionState;
  /** Holds one of the MAX_SESSIONS browser slots. Changed only synchronously. */
  slot: boolean;
  startedAt: number;
  stepStartedAt: number;
  timings: StepTiming[];
  listeners: Set<(event: WireEvent) => void>;
  context?: ContextLike<Page>;
  page?: Page;
  fingerprint?: FingerprintProfile;
  /** Prewarm only: resolves once the login page has loaded (or failed to). */
  pageReady?: Promise<boolean>;
  /** Prewarm only: taken over by a login. */
  adopted?: boolean;
  reuseKey?: string;
  /** Resolved when a slot is granted to this queued login. */
  slotGranted?: Deferred<boolean>;
  /** Resolved with each MFA code the user submits. */
  mfaCode?: Deferred<string>;
  lastMfa?: Extract<WireEvent, { type: 'mfa_required' }>;
  documents?: DocumentMeta[];
  readyDocumentId?: string;
  firstDocumentMs?: number;
  cache: Map<string, DocumentContent>;
  /** Background prefetch of the remaining documents. */
  prefetch?: Promise<void>;
  timers: Set<ReturnType<typeof setTimeout>>;
  /** The failed event was sent and cleanup started. */
  ended?: boolean;
  /** Time spent waiting for the user to type MFA codes (excluded from latency metrics). */
  mfaWaitMs: number;
  /** The saved session was accepted (no login, no MFA). */
  fastPath?: boolean;
  /** A pre-warmed login page was taken over. */
  prewarmed?: boolean;
  /** The outcome was counted in metrics. */
  recorded?: boolean;
}

/**
 * The live sessions: the state machine per session, the browser-slot cap and queue, timeouts,
 * events for SSE, the fast path for saved sessions, and the document cache. Implements the
 * SessionService port; see its comments for the rules (pre-warm adoption, eviction, BUSY).
 */
export class SessionManager<Page> implements SessionService {
  private readonly adapters: Map<string, CarrierAdapter<Page>>;
  private readonly sessions = new Map<string, Live<Page>>();
  /** Logins waiting for a slot, first in first out. */
  private readonly waiting: Live<Page>[] = [];
  private closed = false;
  /** Shutting down: no new logins; in-flight ones may finish. */
  private draining = false;

  constructor(private readonly o: SessionManagerOptions<Page>) {
    this.adapters = new Map(o.adapters.map((a) => [a.info.id, a]));
  }

  // ---------- SessionService ----------

  listCarriers(): CarrierInfo[] {
    return [...this.adapters.values()].map((a) => a.info);
  }

  // async, but with no await before the slot decision: two calls can't interleave inside it.
  async prewarm(ownerId: string, carrierId: string): Promise<{ sessionId: string }> {
    const adapter = this.adapterFor(carrierId);
    if (this.draining) throw new AppError('BUSY');
    // One unused pre-warm per owner: a new pick replaces the old one.
    for (const s of this.sessions.values()) {
      if (s.ownerId === ownerId && this.isUnusedPrewarm(s)) this.discard(s);
    }
    // A pre-warm never takes a slot a waiting login needs.
    if (this.waiting.length > 0 || !this.hasFreeSlot()) throw new AppError('BUSY');
    const s = this.create(ownerId, carrierId, 'prewarm');
    s.slot = true;
    this.apply(s, { type: 'PREWARM' });
    s.pageReady = this.openPrewarm(s, adapter);
    this.after(s, this.o.limits.prewarmTimeoutMs, () => {
      if (this.isUnusedPrewarm(s)) this.discard(s);
    });
    return { sessionId: s.id };
  }

  async start(ownerId: string, input: StartSessionRequest): Promise<{ sessionId: string }> {
    const adapter = this.adapterFor(input.carrierId);
    // Shutting down: the retry lands on the next instance.
    if (this.draining) throw new AppError('BUSY');
    const credentials: Credentials = {};
    for (const f of adapter.info.loginFields) {
      const value = input[f];
      if (!value) throw new AppError('VALIDATION_FAILED');
      credentials[f] = value;
    }

    // Everything up to the slot decision is synchronous, so two requests can't take one slot.
    const prewarmed = this.adoptablePrewarm(ownerId, input);
    const s = this.create(ownerId, input.carrierId, 'login');
    if (prewarmed) {
      prewarmed.adopted = true;
      prewarmed.slot = false;
      s.slot = true;
    } else if (this.hasFreeSlot() || this.evictPrewarm(ownerId)) {
      s.slot = true;
    } else if (this.waiting.length < this.o.limits.maxQueue) {
      this.apply(s, { type: 'QUEUE' });
      s.slotGranted = deferred();
      this.waiting.push(s);
      this.after(s, this.o.limits.queueWaitMs, () => {
        if (s.state.status === 'queued') {
          this.removeWaiting(s);
          this.fail(s, 'BUSY', true);
        }
      });
    } else {
      this.sessions.delete(s.id);
      throw new AppError('BUSY');
    }

    void this.run(s, adapter, credentials, prewarmed);
    return { sessionId: s.id };
  }

  async submitMfa(ownerId: string, sessionId: string, code: string): Promise<void> {
    const s = this.owned(ownerId, sessionId);
    if (s.state.status !== 'mfa_required' || !s.mfaCode) {
      throw new AppError('VALIDATION_FAILED', 'not waiting for a code');
    }
    s.mfaCode.resolve(code);
  }

  subscribe(ownerId: string, sessionId: string, listener: (event: WireEvent) => void): () => void {
    const s = this.owned(ownerId, sessionId);
    // Catch a (re)connecting browser up: current status, then whatever it would have seen.
    listener(this.statusEvent(s));
    if (s.state.status === 'mfa_required' && s.lastMfa) listener(s.lastMfa);
    if (s.documents) listener({ type: 'documents_listed', documents: s.documents });
    if (s.readyDocumentId !== undefined && s.firstDocumentMs !== undefined) {
      listener({
        type: 'document_ready',
        documentId: s.readyDocumentId,
        elapsedMs: s.firstDocumentMs,
      });
    }
    if (s.state.status === 'failed') listener(this.failedEvent(s));
    if (s.state.status === 'done') listener({ type: 'done' });
    s.listeners.add(listener);
    return () => s.listeners.delete(listener);
  }

  async getDocument(
    ownerId: string,
    sessionId: string,
    documentId: string,
  ): Promise<DocumentContent> {
    const s = this.owned(ownerId, sessionId);
    if (!s.documents?.some((d) => d.id === documentId)) throw new AppError('NOT_FOUND');
    const cached = s.cache.get(documentId);
    if (cached) return cached;
    if (s.prefetch) {
      await s.prefetch;
      const prefetched = s.cache.get(documentId);
      if (prefetched) return prefetched;
    }
    return this.fetchFromSavedSession(s, documentId);
  }

  async forget(ownerId: string): Promise<number> {
    for (const s of [...this.sessions.values()]) {
      if (s.ownerId !== ownerId) continue;
      if (!isTerminal(s.state)) this.fail(s, 'SESSION_EXPIRED', false);
      this.destroy(s);
    }
    return this.o.store.deleteByOwner(ownerId);
  }

  /**
   * First step of a graceful shutdown: refuse new logins and pre-warms (BUSY), end queued logins
   * and unused pre-warms now, and wait up to `timeoutMs` for in-flight logins to finish
   * (documents fetched, or failed). close() then ends whatever is left.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.draining = true;
    for (const s of [...this.waiting]) this.fail(s, 'CARRIER_UNAVAILABLE', true);
    for (const s of [...this.sessions.values()]) if (this.isUnusedPrewarm(s)) this.discard(s);
    const deadline = this.o.clock.now() + timeoutMs;
    while (this.inFlight() > 0 && this.o.clock.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
  }

  /** Logins still running: not yet done or failed. */
  inFlight(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.kind === 'login' && !isTerminal(s.state)) n += 1;
    return n;
  }

  /** Close every live session and browser context (graceful shutdown). */
  async close(): Promise<void> {
    this.closed = true;
    const all = [...this.sessions.values()];
    for (const s of all) if (!isTerminal(s.state)) this.fail(s, 'CARRIER_UNAVAILABLE', true);
    await Promise.allSettled(all.map((s) => this.closeContext(s)));
    for (const s of all) this.destroy(s);
  }

  /** Counts for health and status pages. */
  stats(): { live: number; slotsInUse: number; waiting: number } {
    return {
      live: this.sessions.size,
      slotsInUse: this.slotsInUse(),
      waiting: this.waiting.length,
    };
  }

  // ---------- the login flow ----------

  private async run(
    s: Live<Page>,
    adapter: CarrierAdapter<Page>,
    credentials: Credentials,
    prewarmed: Live<Page> | undefined,
  ): Promise<void> {
    try {
      if (s.slotGranted && !(await s.slotGranted.promise)) return;
      if (isTerminal(s.state)) return;

      const identifier = credentials.username ?? credentials.email ?? '';
      s.reuseKey = this.o.mac('reuse', s.ownerId, s.carrierId, identifier.trim().toLowerCase());
      const saved = await this.o.store.get(s.reuseKey);
      const browser = this.o.browserFor(s.carrierId);

      if (saved) {
        // A returning user: the device profile from the saved session, not the pre-warm's.
        if (prewarmed) await this.retirePrewarm(prewarmed);
        this.apply(s, { type: 'CHECK_SAVED_SESSION' });
        const version = await browser.browserVersion();
        s.fingerprint = this.o.refreshFingerprint(saved.fingerprint, version);
        await this.openContext(s, browser, saved.storageState);
        if (await adapter.isSessionValid(s.page!)) {
          this.apply(s, { type: 'FAST_PATH_HIT' });
          s.fastPath = true;
          return await this.fetchDocuments(s, adapter);
        }
        await this.o.store.delete(s.reuseKey);
        // Same context: a device-trust cookie in it may still spare the user an MFA code.
        this.apply(s, { type: 'FAST_PATH_MISS' });
      } else {
        if (prewarmed && (await this.takeOverPrewarm(s, prewarmed))) {
          // The pre-warmed page is already on the login form.
          s.prewarmed = true;
        } else {
          if (prewarmed) await this.retirePrewarm(prewarmed);
          s.fingerprint = this.o.createFingerprint(await browser.browserVersion());
          await this.openContext(s, browser);
        }
        this.apply(s, { type: 'START_LOGIN' });
      }

      let outcome = await adapter.login(s.page!, credentials);
      // Drop our references to what the user typed as soon as the carrier has it.
      for (const f of Object.keys(credentials)) delete credentials[f as keyof Credentials];

      if (outcome.kind === 'mfa_required') outcome = await this.mfaLoop(s, adapter, outcome);
      if (outcome.kind === 'failed') return this.fail(s, outcome.code);
      if (s.state.status === 'logging_in') this.apply(s, { type: 'LOGIN_OK' });
      if (isTerminal(s.state)) return;

      void this.save(s);
      await this.fetchDocuments(s, adapter);
    } catch (err) {
      this.failFromError(s, err);
    }
  }

  private async mfaLoop(
    s: Live<Page>,
    adapter: CarrierAdapter<Page>,
    first: Extract<LoginOutcome, { kind: 'mfa_required' }>,
  ): Promise<LoginOutcome> {
    this.apply(s, { type: 'MFA_REQUESTED' });
    let outcome: LoginOutcome = first;
    while (outcome.kind === 'mfa_required') {
      this.emitMfa(s, outcome.hint, outcome.rejected === true);
      const code = await this.waitForCode(s);
      if (code === undefined) return { kind: 'failed', code: 'MFA_TIMEOUT' };
      this.apply(s, { type: 'MFA_SUBMITTED' });
      outcome = await adapter.submitMfa(s.page!, code);
      if (outcome.kind === 'mfa_required') {
        this.apply(s, { type: 'MFA_REJECTED' });
        if (isTerminal(s.state)) return { kind: 'failed', code: 'MFA_INVALID' };
      }
    }
    if (outcome.kind === 'ok') this.apply(s, { type: 'MFA_OK' });
    return outcome;
  }

  /** The next code the user submits, or undefined after MFA_TIMEOUT. */
  private waitForCode(s: Live<Page>): Promise<string | undefined> {
    const code = deferred<string | undefined>();
    s.mfaCode = code as Deferred<string>;
    const waitStarted = this.o.clock.now();
    const timer = this.after(s, this.o.limits.mfaTimeoutMs, () => code.resolve(undefined));
    return code.promise.finally(() => {
      s.mfaWaitMs += this.o.clock.now() - waitStarted;
      clearTimeout(timer);
      s.timers.delete(timer);
      s.mfaCode = undefined;
    });
  }

  private async fetchDocuments(s: Live<Page>, adapter: CarrierAdapter<Page>): Promise<void> {
    const page = s.page!;
    const documents = await adapter.listDocuments(page);
    s.documents = documents;
    this.emit(s, { type: 'documents_listed', documents });
    const first = documents[0];
    if (!first) return this.finish(s);

    s.cache.set(first.id, await adapter.fetchDocument(page, first.id));
    this.apply(s, { type: 'DOCUMENT_READY' });
    s.readyDocumentId = first.id;
    s.firstDocumentMs = this.o.clock.now() - s.startedAt;
    this.emit(s, { type: 'document_ready', documentId: first.id, elapsedMs: s.firstDocumentMs });

    // The rest in the background, then free the slot: the session doesn't idle on a browser.
    s.prefetch = (async () => {
      for (const doc of documents.slice(1)) {
        try {
          s.cache.set(doc.id, await adapter.fetchDocument(page, doc.id));
        } catch (err) {
          // One missing document isn't a failed session; a click retries from the saved session.
          this.o.logger.warn(
            { sessionId: s.id, code: codeOf(err), step: stepOf(err) },
            'prefetch failed',
          );
        }
      }
    })();
    await s.prefetch;
    s.prefetch = undefined;
    await this.finish(s);
  }

  /** Done: close the context, free the slot, keep documents in memory for a while. */
  private async finish(s: Live<Page>): Promise<void> {
    // Ended meanwhile ("Forget me", shutdown): it already sent failed and cleaned up.
    if (s.ended) return;
    if (canTransition(s.state, { type: 'CLOSE' })) this.apply(s, { type: 'CLOSE' });
    this.record(s, 'done');
    this.emit(s, { type: 'done' });
    await this.closeContext(s);
    this.after(s, this.o.limits.documentCacheMs, () => this.destroy(s));
  }

  private async save(s: Live<Page>): Promise<void> {
    try {
      if (!s.context || !s.reuseKey || !s.fingerprint) return;
      const storageState = await s.context.storageState();
      await this.o.store.put(
        s.reuseKey,
        s.ownerId,
        {
          carrierId: s.carrierId,
          storageState,
          fingerprint: s.fingerprint,
          savedAt: this.o.clock.now(),
        },
        this.o.limits.sessionTtlMs,
      );
    } catch (err) {
      // A failed save costs the next run a full login; this run carries on.
      this.o.logger.warn(
        isAppError(err)
          ? { sessionId: s.id, code: err.code, step: stepOf(err) }
          : { sessionId: s.id, code: 'INTERNAL', err },
        'session save failed',
      );
    }
  }

  /** A document clicked after the cache expired, or that the prefetch missed. */
  private async fetchFromSavedSession(s: Live<Page>, documentId: string): Promise<DocumentContent> {
    const saved = s.reuseKey ? await this.o.store.get(s.reuseKey) : undefined;
    if (!saved) throw new AppError('SESSION_EXPIRED');
    if (!this.hasFreeSlot() && !this.evictPrewarm(s.ownerId)) throw new AppError('BUSY');
    const browser = this.o.browserFor(s.carrierId);
    const temp = this.create(s.ownerId, s.carrierId, 'login');
    temp.slot = true;
    try {
      temp.fingerprint = this.o.refreshFingerprint(
        saved.fingerprint,
        await browser.browserVersion(),
      );
      await this.openContext(temp, browser, saved.storageState);
      const doc = await this.adapterFor(s.carrierId).fetchDocument(temp.page!, documentId);
      s.cache.set(documentId, doc);
      return doc;
    } finally {
      await this.closeContext(temp);
      this.destroy(temp);
    }
  }

  // ---------- pre-warm ----------

  private async openPrewarm(s: Live<Page>, adapter: CarrierAdapter<Page>): Promise<boolean> {
    try {
      const browser = this.o.browserFor(s.carrierId);
      s.fingerprint = this.o.createFingerprint(await browser.browserVersion());
      await this.openContext(s, browser);
      await adapter.openLogin(s.page!);
      return true;
    } catch (err) {
      // Best effort: the login will open its own page.
      this.o.logger.info(
        { sessionId: s.id, code: codeOf(err), step: stepOf(err) },
        'prewarm failed',
      );
      return false;
    }
  }

  private adoptablePrewarm(ownerId: string, input: StartSessionRequest): Live<Page> | undefined {
    if (!input.prewarmSessionId) return undefined;
    const p = this.sessions.get(input.prewarmSessionId);
    // Another owner's ID is treated exactly like an unknown one.
    if (!p || p.ownerId !== ownerId || p.carrierId !== input.carrierId) return undefined;
    return this.isUnusedPrewarm(p) ? p : undefined;
  }

  /** Move the pre-warmed context into the login session. False if the pre-warm failed. */
  private async takeOverPrewarm(s: Live<Page>, p: Live<Page>): Promise<boolean> {
    const ready = await p.pageReady;
    if (!ready || !p.context || !p.page) return false;
    s.context = p.context;
    s.page = p.page;
    s.fingerprint = p.fingerprint;
    p.context = undefined;
    p.page = undefined;
    this.destroy(p);
    return true;
  }

  /** An adopted pre-warm whose page won't be used: close it (its slot already moved). */
  private async retirePrewarm(p: Live<Page>): Promise<void> {
    await p.pageReady;
    await this.closeContext(p);
    this.destroy(p);
  }

  private isUnusedPrewarm(s: Live<Page>): boolean {
    return s.kind === 'prewarm' && !s.adopted && s.state.status === 'prewarming';
  }

  /** Free a slot for a login by closing an unused pre-warm: this owner's first, then the oldest. */
  private evictPrewarm(ownerId: string): boolean {
    const unused = [...this.sessions.values()].filter((s) => this.isUnusedPrewarm(s) && s.slot);
    const victim = unused.find((s) => s.ownerId === ownerId) ?? unused[0];
    if (!victim) return false;
    victim.slot = false;
    this.discard(victim);
    return true;
  }

  /** Close a pre-warm quietly: nobody is listening to it. */
  private discard(s: Live<Page>): void {
    if (canTransition(s.state, { type: 'CLOSE' })) this.apply(s, { type: 'CLOSE' });
    void (s.pageReady ?? Promise.resolve(false)).then(() => this.closeContext(s));
    this.destroy(s);
  }

  // ---------- slots and the queue ----------

  private slotsInUse(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.slot) n += 1;
    return n;
  }

  private hasFreeSlot(): boolean {
    return !this.closed && !this.draining && this.slotsInUse() < this.o.limits.maxSessions;
  }

  private release(s: Live<Page>): void {
    if (!s.slot) return;
    s.slot = false;
    while (this.waiting.length > 0 && this.hasFreeSlot()) {
      const next = this.waiting.shift()!;
      next.slot = true;
      next.slotGranted?.resolve(true);
    }
  }

  private removeWaiting(s: Live<Page>): void {
    const i = this.waiting.indexOf(s);
    if (i >= 0) this.waiting.splice(i, 1);
    s.slotGranted?.resolve(false);
  }

  // ---------- browser contexts ----------

  private async openContext(s: Live<Page>, browser: CarrierBrowser<Page>, storageState?: unknown) {
    const options: Parameters<CarrierBrowser<Page>['newContext']>[0] = {
      fingerprint: s.fingerprint!,
    };
    if (storageState !== undefined) options.storageState = storageState;
    const proxy = browser.proxy();
    if (proxy) options.proxy = proxy;
    s.context = await browser.newContext(options);
    s.page = await s.context.newPage();
  }

  private async closeContext(s: Live<Page>): Promise<void> {
    const context = s.context;
    s.context = undefined;
    s.page = undefined;
    this.release(s);
    if (context) await context.close().catch(() => undefined);
  }

  // ---------- state, events, lifecycle ----------

  private create(ownerId: string, carrierId: string, kind: Live<Page>['kind']): Live<Page> {
    const now = this.o.clock.now();
    const s: Live<Page> = {
      id: randomUUID(),
      ownerId,
      carrierId,
      kind,
      state: initialState,
      slot: false,
      startedAt: now,
      stepStartedAt: now,
      timings: [],
      listeners: new Set(),
      cache: new Map(),
      timers: new Set(),
      mfaWaitMs: 0,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  private apply(s: Live<Page>, event: SessionEvent): void {
    if (!canTransition(s.state, event)) return;
    const now = this.o.clock.now();
    if (s.state.status !== 'idle') {
      s.timings.push({ step: s.state.status, ms: now - s.stepStartedAt });
    }
    s.stepStartedAt = now;
    s.state = transition(s.state, event);
    this.emit(s, this.statusEvent(s));
  }

  /**
   * End the session as failed, once. The state may already be 'failed' (a third wrong MFA code
   * fails inside the state machine); the failed event and cleanup still happen here.
   */
  private fail(s: Live<Page>, code: ErrorCode, retryable = ERROR_INFO[code].retryable): void {
    if (s.ended || s.state.status === 'done') return;
    s.ended = true;
    if (!isTerminal(s.state)) this.apply(s, { type: 'FAIL', code, retryable });
    this.record(s, s.state.error?.code ?? code);
    this.emit(s, this.failedEvent(s));
    this.removeWaiting(s);
    void this.closeContext(s).then(() =>
      this.after(s, this.o.limits.documentCacheMs, () => this.destroy(s)),
    );
  }

  /** Count a login's outcome once, for GET /api/status, and log it as one line. */
  private record(s: Live<Page>, outcome: 'done' | ErrorCode): void {
    if (s.kind !== 'login' || s.recorded) return;
    s.recorded = true;
    const firstDocumentMs =
      s.firstDocumentMs === undefined ? undefined : s.firstDocumentMs - s.mfaWaitMs;
    const fastPath = s.fastPath === true;
    const prewarmed = s.prewarmed === true;
    this.o.logger.info(
      { sessionId: s.id, carrierId: s.carrierId, outcome, firstDocumentMs, fastPath, prewarmed },
      'login outcome',
    );
    this.o.metrics?.record({
      carrierId: s.carrierId,
      outcome,
      ...(firstDocumentMs === undefined ? {} : { firstDocumentMs }),
      fastPath,
      prewarmed,
    });
  }

  private failFromError(s: Live<Page>, err: unknown): void {
    let code = codeOf(err);
    // An adapter checking a dead page sees "wrong page" or a raw error; the real cause is the
    // browser going away (crash, kill, shutdown), which is retryable.
    if ((code === 'CARRIER_PAGE_CHANGED' || code === 'INTERNAL') && this.pageGone(s)) {
      code = 'CARRIER_UNAVAILABLE';
    }
    if (code === 'INTERNAL') this.o.logger.error({ sessionId: s.id, err }, 'session failed');
    else if (code === 'CARRIER_UNAVAILABLE' && (isBrowserGone(err) || this.pageGone(s))) {
      this.o.logger.warn({ sessionId: s.id, code, step: stepOf(err) }, 'browser went away');
    } else this.o.logger.info({ sessionId: s.id, code, step: stepOf(err) }, 'session failed');
    this.fail(s, code);
  }

  /** The session's page was closed under it (the browser crashed or was closed). */
  private pageGone(s: Live<Page>): boolean {
    const page = s.page as { isClosed?: () => boolean } | undefined;
    return typeof page?.isClosed === 'function' && page.isClosed();
  }

  private emitMfa(s: Live<Page>, hint: string | undefined, rejected: boolean): void {
    const event: Extract<WireEvent, { type: 'mfa_required' }> = {
      type: 'mfa_required',
      attemptsLeft: MAX_MFA_ATTEMPTS - s.state.mfaAttempts,
      lastAttemptRejected: rejected,
    };
    if (hint) event.hint = hint;
    s.lastMfa = event;
    this.emit(s, event);
  }

  private statusEvent(s: Live<Page>): WireEvent {
    return {
      type: 'status',
      status: s.state.status,
      timings: [...s.timings],
      elapsedMs: this.o.clock.now() - s.startedAt,
    };
  }

  private failedEvent(s: Live<Page>): WireEvent {
    const code = s.state.error?.code ?? 'INTERNAL';
    return {
      type: 'failed',
      code,
      message: ERROR_INFO[code].message,
      retryable: s.state.error?.retryable ?? false,
    };
  }

  private emit(s: Live<Page>, event: WireEvent): void {
    for (const listener of s.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.o.logger.warn({ sessionId: s.id, err }, 'event listener threw');
      }
    }
  }

  private after(s: Live<Page>, ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      s.timers.delete(timer);
      fn();
    }, ms);
    timer.unref?.();
    s.timers.add(timer);
    return timer;
  }

  /** Forget the session record (its context is already closed or being closed). */
  private destroy(s: Live<Page>): void {
    for (const t of s.timers) clearTimeout(t);
    s.timers.clear();
    this.release(s);
    this.removeWaiting(s);
    this.sessions.delete(s.id);
  }

  private owned(ownerId: string, sessionId: string): Live<Page> {
    const s = this.sessions.get(sessionId);
    if (!s || s.ownerId !== ownerId || s.kind !== 'login') throw new AppError('NOT_FOUND');
    return s;
  }

  private adapterFor(carrierId: string): CarrierAdapter<Page> {
    const adapter = this.adapters.get(carrierId);
    if (!adapter) throw new AppError('VALIDATION_FAILED', 'unknown carrier');
    return adapter;
  }
}

function codeOf(err: unknown): ErrorCode {
  if (isAppError(err)) return err.code;
  return isBrowserGone(err) ? 'CARRIER_UNAVAILABLE' : 'INTERNAL';
}

/**
 * Which step failed, for logs: an AppError's detail is our own wording ("code field",
 * "ID cards link", "document 500"), never page content or user data. Other errors are logged
 * whole under `err` at INTERNAL.
 */
function stepOf(err: unknown): string | undefined {
  return isAppError(err) ? err.message.slice(0, 120) : undefined;
}

const DRAIN_POLL_MS = 100;
