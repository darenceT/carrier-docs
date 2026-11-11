/**
 * Mock carrier portal used by the Demo carrier and the end-to-end tests.
 *
 * Phase 1 placeholder: the login form, MFA page, document list and sample PDFs
 * arrive in Phase 3 (step 8). It will be mounted by the server at /demo-portal.
 */
export const MOCK_PORTAL_BASE_PATH = '/demo-portal';

/** The MFA code the mock portal accepts. Safe to publish: it only unlocks fixture data. */
export const MOCK_PORTAL_MFA_CODE = '123456';
