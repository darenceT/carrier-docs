import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

// The server refuses to start without valid secrets. Throwaway values per run; never real ones.
const testSecrets = {
  SESSION_KEY: randomBytes(32).toString('base64'),
  ACCESS_CODE: 'e2e-access-code',
  CANARY_TOKEN: 'e2e-canary-token-not-secret',
};

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && node apps/server/dist/index.js',
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { ...testSecrets, PORT: String(PORT), DATA_DIR: 'data/e2e', LOG_LEVEL: 'warn' },
  },
});
