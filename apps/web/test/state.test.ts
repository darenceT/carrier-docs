import type { DocumentMeta, SessionEvent } from '@carrier-docs/contracts';
import { describe, expect, it } from 'vitest';
import { initialState, reducer, screenOf, type Action, type State } from '../src/state.ts';

const CARRIERS = [
  { id: 'demo', name: 'Demo carrier (test fixture)', isDemo: true },
  { id: 'progressive', name: 'Progressive', isDemo: false },
];

const DOCS: DocumentMeta[] = [
  { id: 'd1', title: 'ID card', kind: 'id_card', mimeType: 'application/pdf' },
  { id: 'd2', title: 'Declarations', kind: 'declarations', mimeType: 'application/pdf' },
];

const run = (actions: Action[], from: State = initialState) => actions.reduce(reducer, from);

const status = (
  s: Extract<SessionEvent, { type: 'status' }>['status'],
  ms = 100,
): SessionEvent => ({
  type: 'status',
  status: s,
  timings: [{ step: 'login', ms }],
  elapsedMs: ms,
});

/** Carriers loaded, demo carrier picked and prewarmed, credentials typed. */
const typed = (): State =>
  run([
    { type: 'carriers_loaded', carriers: CARRIERS },
    { type: 'carrier_selected', carrierId: 'demo' },
    { type: 'prewarmed', carrierId: 'demo', sessionId: 'pw-1' },
    { type: 'field_changed', field: 'username', value: 'alice' },
    { type: 'field_changed', field: 'password', value: 'hunter2' },
  ]);

const started = (): State =>
  run(
    [{ type: 'login_submitted' }, { type: 'session_started', sessionId: 's1', at: 1000 }],
    typed(),
  );

describe('access', () => {
  it('shows the access screen on 401 and leaves it once granted', () => {
    let s = reducer(initialState, { type: 'access_required' });
    expect(screenOf(s)).toBe('access');
    s = reducer(s, { type: 'access_submitted' });
    expect(s.accessSubmitting).toBe(true);
    s = reducer(s, { type: 'access_failed', message: 'bad' });
    expect(s.accessError).toBe('bad');
    expect(screenOf(s)).toBe('access');
    s = run([{ type: 'access_submitted' }, { type: 'access_granted' }], s);
    expect(s.accessError).toBeUndefined();
    expect(screenOf(s)).toBe('login');
  });
});

describe('carrier and prewarm', () => {
  it('keeps the prewarm session id for the selected carrier', () => {
    const s = typed();
    expect(s.carrierId).toBe('demo');
    expect(s.prewarmSessionId).toBe('pw-1');
  });

  it('ignores a late prewarm for a carrier no longer selected', () => {
    const s = run([
      { type: 'carrier_selected', carrierId: 'demo' },
      { type: 'carrier_selected', carrierId: 'progressive' },
      { type: 'prewarmed', carrierId: 'demo', sessionId: 'pw-old' },
    ]);
    expect(s.prewarmSessionId).toBeUndefined();
  });
});

describe('login', () => {
  it('clears the password as soon as the login POST is sent', () => {
    const s = reducer(typed(), { type: 'login_submitted' });
    expect(s.password).toBe('');
    expect(s.username).toBe('alice');
    expect(screenOf(s)).toBe('starting');
    expect(JSON.stringify(s)).not.toContain('hunter2');
  });

  it('never holds the password once the session started', () => {
    const s = started();
    expect(s.password).toBe('');
    expect(JSON.stringify(s)).not.toContain('hunter2');
    expect(s.sessionId).toBe('s1');
    expect(s.prewarmSessionId).toBeUndefined();
    expect(screenOf(s)).toBe('waiting');
  });

  it('shows a start error on the login form without the password', () => {
    const s = run(
      [
        { type: 'login_submitted' },
        { type: 'login_failed', error: { code: 'BUSY', message: 'x' } },
      ],
      typed(),
    );
    expect(screenOf(s)).toBe('login');
    expect(s.loginError?.code).toBe('BUSY');
    expect(s.password).toBe('');
  });
});

describe('full MFA flow', () => {
  it('goes login -> mfa -> verifying -> documents -> done', () => {
    let s = run([status('logging_in')], started());
    expect(s.status).toBe('logging_in');
    expect(screenOf(s)).toBe('waiting');

    s = run(
      [
        status('mfa_required'),
        {
          type: 'mfa_required',
          hint: 'Code sent to 1234',
          attemptsLeft: 3,
          lastAttemptRejected: false,
        },
      ],
      s,
    );
    expect(screenOf(s)).toBe('mfa');
    expect(s.mfa).toEqual({
      hint: 'Code sent to 1234',
      attemptsLeft: 3,
      lastAttemptRejected: false,
    });

    s = reducer(s, { type: 'field_changed', field: 'mfaCode', value: '123456' });
    expect(s.mfaCode).toBe('123456');
    s = run([{ type: 'mfa_submitted' }, { type: 'mfa_accepted' }], s);
    expect(s.mfaCode).toBe('');
    expect(screenOf(s)).toBe('waiting');

    s = run([status('verifying_mfa'), status('fetching_docs', 900)], s);
    expect(s.mfa).toBeUndefined();
    expect(s.timings).toEqual([{ step: 'login', ms: 900 }]);
    expect(s.serverElapsedMs).toBe(900);

    s = reducer(s, { type: 'documents_listed', documents: DOCS });
    expect(screenOf(s)).toBe('documents');
    expect(s.selectedDocumentId).toBeUndefined();

    s = reducer(s, { type: 'document_ready', documentId: 'd1', elapsedMs: 4321 });
    expect(s.firstDocumentMs).toBe(4321);
    expect(s.selectedDocumentId).toBe('d1');
    expect(s.readyDocumentId).toBe('d1');

    s = reducer(s, { type: 'document_selected', documentId: 'd2' });
    expect(s.selectedDocumentId).toBe('d2');

    s = reducer(s, { type: 'done' });
    expect(s.finished).toBe(true);
    expect(s.status).toBe('done');
    expect(screenOf(s)).toBe('documents');
    expect(JSON.stringify(s)).not.toContain('123456');
  });

  it('shows a rejected code and the remaining attempts', () => {
    let s = run(
      [
        { type: 'mfa_required', attemptsLeft: 3, lastAttemptRejected: false },
        { type: 'field_changed', field: 'mfaCode', value: '000000' },
        { type: 'mfa_submitted' },
        status('verifying_mfa'),
      ],
      started(),
    );
    expect(screenOf(s)).toBe('waiting');
    s = run(
      [
        status('mfa_required'),
        { type: 'mfa_required', attemptsLeft: 2, lastAttemptRejected: true },
      ],
      s,
    );
    expect(screenOf(s)).toBe('mfa');
    expect(s.mfa?.lastAttemptRejected).toBe(true);
    expect(s.mfa?.attemptsLeft).toBe(2);
    expect(s.mfaCode).toBe('');
  });

  it('returns to the MFA form when the MFA POST itself fails', () => {
    const s = run(
      [
        { type: 'mfa_required', attemptsLeft: 3, lastAttemptRejected: false },
        { type: 'mfa_submitted' },
        { type: 'mfa_post_failed', error: { code: 'RATE_LIMITED', message: 'slow down' } },
      ],
      started(),
    );
    expect(screenOf(s)).toBe('mfa');
    expect(s.mfaError?.code).toBe('RATE_LIMITED');
  });
});

describe('fast path without MFA', () => {
  it('goes from status straight to documents', () => {
    const s = run(
      [
        status('logging_in'),
        status('fetching_docs'),
        { type: 'documents_listed', documents: DOCS },
        { type: 'document_ready', documentId: 'd1', elapsedMs: 2500 },
        status('document_ready'),
        { type: 'done' },
      ],
      started(),
    );
    expect(s.mfa).toBeUndefined();
    expect(screenOf(s)).toBe('documents');
    expect(s.firstDocumentMs).toBe(2500);
    expect(s.finished).toBe(true);
  });
});

describe('failure', () => {
  it('shows the failure and offers try again when retryable', () => {
    let s = run(
      [
        status('logging_in'),
        { type: 'failed', code: 'INVALID_CREDENTIALS', message: 'nope', retryable: true },
      ],
      started(),
    );
    expect(screenOf(s)).toBe('failed');
    expect(s.failure).toEqual({ code: 'INVALID_CREDENTIALS', message: 'nope', retryable: true });
    expect(s.finished).toBe(true);

    // Events after the end are ignored.
    s = reducer(s, status('fetching_docs'));
    expect(s.status).toBe('failed');

    s = reducer(s, { type: 'try_again' });
    expect(screenOf(s)).toBe('login');
    expect(s.carrierId).toBe('demo');
    expect(s.username).toBe('alice');
    expect(s.password).toBe('');
    expect(s.sessionId).toBeUndefined();
    expect(s.failure).toBeUndefined();
  });

  it('treats a lost stream as a retryable failure, but not after done', () => {
    const lost = reducer(started(), { type: 'stream_lost' });
    expect(screenOf(lost)).toBe('failed');
    expect(lost.failure?.retryable).toBe(true);

    const done = run([{ type: 'done' }, { type: 'stream_lost' }], started());
    expect(done.failure).toBeUndefined();
  });
});

describe('timer', () => {
  it('ticks while running and freezes when finished', () => {
    let s = reducer(started(), { type: 'tick', now: 3500 });
    expect(s.clientElapsedMs).toBe(2500);
    s = run([{ type: 'done' }, { type: 'tick', now: 9000 }], s);
    expect(s.clientElapsedMs).toBe(2500);
  });
});

describe('start over and forget me', () => {
  it('start over resets everything but the carrier list', () => {
    const s = reducer(started(), { type: 'start_over' });
    expect(s).toEqual({ ...initialState, carriers: CARRIERS });
  });

  it('forget me resets and reports how many were deleted', () => {
    const s = reducer(started(), { type: 'forgotten', deleted: 2 });
    expect(s).toEqual({ ...initialState, carriers: CARRIERS, forgotten: 2 });
  });
});
