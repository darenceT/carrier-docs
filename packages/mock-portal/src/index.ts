/**
 * Mock carrier portal used by the Demo carrier and the end-to-end tests: a fake insurance site
 * with a login form, an MFA step, a dashboard, a JSON documents API and real (fake) PDFs.
 * The server mounts it at /demo-portal. All data is obviously fake.
 */
export {
  MOCK_PORTAL_BASE_PATH,
  MOCK_PORTAL_COOKIES,
  MOCK_PORTAL_MAX_MFA_ATTEMPTS,
  MOCK_PORTAL_MFA_CODE,
  MOCK_PORTAL_USERNAMES,
  createMockPortalApp,
  createMockPortalRouter,
  type MockPortalOptions,
} from './portal.js';
export { MOCK_DOCUMENTS, MOCK_POLICIES, type MockDocument, type MockDocumentKind } from './data.js';
export { buildPdf, type PdfLine } from './pdf.js';
