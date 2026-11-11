import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'data/**',
      'fixtures/raw/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Type-aware promise rules. The server is async end to end (browser automation, SSE,
    // timers), and a forgotten `await` there fails silently: an unhandled rejection or a
    // step that runs out of order.
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Server code logs through the redacting pino logger (Phase 3), never console.
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/index.ts', 'apps/server/src/scripts/**'],
    rules: { 'no-console': 'error' },
  },
);
