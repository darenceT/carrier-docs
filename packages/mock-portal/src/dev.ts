/** Run the mock portal standalone for manual poking: `npm run dev -w packages/mock-portal`. */
import { MOCK_PORTAL_BASE_PATH, createMockPortalApp } from './portal.js';

const port = Number(process.env.PORT ?? 4000);
createMockPortalApp().listen(port, () => {
  console.info(`Mock portal: http://localhost:${port}${MOCK_PORTAL_BASE_PATH}/login`);
});
