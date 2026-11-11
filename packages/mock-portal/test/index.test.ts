import { describe, expect, it } from 'vitest';
import { MOCK_PORTAL_BASE_PATH, MOCK_PORTAL_MFA_CODE } from '../src/index.js';

describe('mock portal constants', () => {
  it('mounts under /demo-portal with the documented MFA code', () => {
    expect(MOCK_PORTAL_BASE_PATH).toBe('/demo-portal');
    expect(MOCK_PORTAL_MFA_CODE).toMatch(/^\d{6}$/);
  });
});
