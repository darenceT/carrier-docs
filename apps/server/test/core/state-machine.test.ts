import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import {
  MAX_MFA_ATTEMPTS,
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

  it('takes the fast path straight to documents when a saved session is valid', () => {
    expect(transition(initialState, { type: 'FAST_PATH_HIT' }).status).toBe('fetching_docs');
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
    'prewarming',
    'logging_in',
    'mfa_required',
    'verifying_mfa',
    'fetching_docs',
    'document_ready',
  ])('FAIL is valid from %s and records the code', (status) => {
    const s = transition(at(status), { type: 'FAIL', code: 'BLOCKED', retryable: false });
    expect(s.status).toBe('failed');
    expect(s.error).toEqual({ code: 'BLOCKED', retryable: false });
  });

  it.each<[Status, SessionEvent]>([
    ['idle', { type: 'MFA_SUBMITTED' }],
    ['logging_in', { type: 'DOCUMENT_READY' }],
    ['mfa_required', { type: 'LOGIN_OK' }],
    ['fetching_docs', { type: 'START_LOGIN' }],
    ['prewarming', { type: 'FAST_PATH_HIT' }],
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
    expect(holdsBrowserSlot(at('prewarming'))).toBe(true);
    expect(holdsBrowserSlot(at('mfa_required'))).toBe(true);
    expect(holdsBrowserSlot(at('document_ready'))).toBe(true);
    expect(holdsBrowserSlot(at('done'))).toBe(false);
    expect(holdsBrowserSlot(at('failed'))).toBe(false);
  });
});
