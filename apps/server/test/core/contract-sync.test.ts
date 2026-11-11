import type { ErrorCode as ContractErrorCode, SessionStatus } from '@carrier-docs/contracts';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, type ErrorCode } from '../../src/core/errors.js';
import { STATUSES, type Status } from '../../src/core/state-machine.js';

// Compile-time checks: these lines stop compiling if the server and the shared contract drift.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const errorCodesMatch: Same<ErrorCode, ContractErrorCode> = true;
const statusesMatch: Same<Status, SessionStatus> = true;

describe('shared contract', () => {
  it('server error codes and statuses match @carrier-docs/contracts', () => {
    expect(errorCodesMatch).toBe(true);
    expect(statusesMatch).toBe(true);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(new Set(STATUSES).size).toBe(STATUSES.length);
  });
});
