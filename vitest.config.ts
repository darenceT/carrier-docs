import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run before anything is built, so use the mock portal's source, not its dist/.
    alias: {
      '@carrier-docs/mock-portal': fileURLToPath(
        new URL('./packages/mock-portal/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
