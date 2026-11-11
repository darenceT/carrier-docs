import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import {
  MAX_MFA_ATTEMPTS,
  canTransition,
  holdsBrowserSlot,
  initialState,
  transition,
  type SessionEvent,
  type SessionState,
  type Status,
} from '../../src/core/state-machine.js';

const at = (status: Status, mfaAttempts = 0): SessionState => ({ status, mfaAttempts });
const run = (events: SessionEvent[], from: SessionState = initialState) =>
  events.reduce(transition, from);

describe('session state machine', () => {
  it('walks the full MFA path to done', () => {
    const end = run([
      { type: 'PREWARM' },
      { type: 'START_LOGIN' },
      { type: 'MFA_REQUESTED' },
      { type: 'MFA_SUBMITTED' },
      { type: 'MFA_OK' },
      { type: 'DOCUMENT_READY' },
      { type: 'CLOSE' },
    ]);
    expect(end).toEqual({ status: 'done', mfaAttempts: 0 });
  });

  it('skips MFA when the carrier trusts the device', () => {
    expect(run([{ type: 'START_LOGIN' }, { type: 'LOGIN_OK' }]).status).toBe('fetching_docs');
  });

  it.each<Status>(['idle', 'prewarming'])(
    'takes the fast path from %s when the saved session is valid (no login, no MFA)',
    (from) => {
      const end = run([{ type: 'CHECK_SAVED_SESSION' }, { type: 'FAST_PATH_HIT' }], at(from));
      expect(end).toEqual({ status: 'fetching_docs', mfaAttempts: 0 });
    },
  );

  it('falls back to a full login when the saved session is rejected', () => {
    const end = run([
      { type: 'PREWARM' },
      { type: 'CHECK_SAVED_SESSION' },
      { type: 'FAST_PATH_MISS' },
      { type: 'MFA_REQUESTED' },
    ]);
    expect(end.status).toBe('mfa_required');
  });

  it('allows MFA retries, then fails with MFA_INVALID on the last attempt', () => {
    let s = at('mfa_required');
    for (let i = 1; i < MAX_MFA_ATTEMPTS; i++) {
      s = run([{ type: 'MFA_SUBMITTED' }, { type: 'MFA_REJECTED' }], s);
      expect(s).toEqual({ status: 'mfa_required', mfaAttempts: i });
    }
    s = run([{ type: 'MFA_SUBMITTED' }, { type: 'MFA_REJECTED' }], s);
    expect(s).toEqual({
      status: 'failed',
      mfaAttempts: MAX_MFA_ATTEMPTS,
      error: { code: 'MFA_INVALID', retryable: false },
    });
  });

  it.each<Status>([
    'idle',
    'queued',
    'prewarming',
    'checking_session',
    'logging_in',
    'mfa_required',
    'verifying_mfa',
    'fetching_docs',
    'document_ready',
  ])('FAIL is valid from %s and records the code', (status) => {
    const s = transition(at(status), { type: 'FAIL', code: 'CARRIER_BLOCKED', retryable: false });
    expect(s.status).toBe('failed');
    expect(s.error).toEqual({ code: 'CARRIER_BLOCKED', retryable: false });
  });

  it.each<[Status, SessionEvent]>([
    ['idle', { type: 'MFA_SUBMITTED' }],
    ['logging_in', { type: 'DOCUMENT_READY' }],
    ['mfa_required', { type: 'LOGIN_OK' }],
    ['fetching_docs', { type: 'START_LOGIN' }],
    ['prewarming', { type: 'FAST_PATH_HIT' }],
    ['idle', { type: 'FAST_PATH_HIT' }],
    ['logging_in', { type: 'CHECK_SAVED_SESSION' }],
    ['checking_session', { type: 'MFA_REQUESTED' }],
    ['prewarming', { type: 'QUEUE' }],
    ['queued', { type: 'QUEUE' }],
    ['queued', { type: 'PREWARM' }],
  ])('rejects invalid transitions (%s + %o)', (status, event) => {
    expect(() => transition(at(status), event)).toThrow(AppError);
  });

  it.each<Status>(['done', 'failed'])('allows nothing out of terminal state %s', (status) => {
    expect(() => transition(at(status), { type: 'CLOSE' })).toThrow(AppError);
    expect(() =>
      transition(at(status), { type: 'FAIL', code: 'INTERNAL', retryable: true }),
    ).toThrow(AppError);
  });

  it('counts only active, non-idle sessions toward the browser-slot cap', () => {
    expect(holdsBrowserSlot(at('idle'))).toBe(false);
    expect(holdsBrowserSlot(at('queued'))).toBe(false);
    expect(holdsBrowserSlot(at('prewarming'))).toBe(true);
    expect(holdsBrowserSlot(at('checking_session'))).toBe(true);
    expect(holdsBrowserSlot(at('mfa_required'))).toBe(true);
    expect(holdsBrowserSlot(at('document_ready'))).toBe(true);
    expect(holdsBrowserSlot(at('done'))).toBe(false);
    expect(holdsBrowserSlot(at('failed'))).toBe(false);
  });

  it('a queued login leaves the line for a full login or the fast path', () => {
    expect(run([{ type: 'QUEUE' }, { type: 'START_LOGIN' }]).status).toBe('logging_in');
    expect(run([{ type: 'QUEUE' }, { type: 'CHECK_SAVED_SESSION' }]).status).toBe(
      'checking_session',
    );
  });

  it('a queued login fails with BUSY when the wait runs out, or closes if abandoned', () => {
    const busy = run([{ type: 'QUEUE' }, { type: 'FAIL', code: 'BUSY', retryable: true }]);
    expect(busy).toMatchObject({ status: 'failed', error: { code: 'BUSY', retryable: true } });
    expect(run([{ type: 'QUEUE' }, { type: 'CLOSE' }]).status).toBe('done');
  });

  it('a login with no documents closes from fetching_docs', () => {
    expect(transition(at('fetching_docs'), { type: 'CLOSE' }).status).toBe('done');
  });

  it('canTransition reports late or invalid events without throwing', () => {
    expect(canTransition(at('done'), { type: 'FAIL', code: 'MFA_TIMEOUT', retryable: true })).toBe(
      false,
    );
    expect(
      canTransition(at('mfa_required'), { type: 'FAIL', code: 'MFA_TIMEOUT', retryable: true }),
    ).toBe(true);
    expect(canTransition(at('idle'), { type: 'MFA_SUBMITTED' })).toBe(false);
    expect(canTransition(at('checking_session'), { type: 'FAST_PATH_HIT' })).toBe(true);
  });
});
