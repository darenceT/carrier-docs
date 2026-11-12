import path from 'node:path';
import { createApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './infra/config.js';
import { createLogger } from './infra/logger.js';
import { createServices } from './services.js';
import { createShutdown, DRAIN_MS, HARD_STOP_MS } from './shutdown.js';

// Validate every env var before doing anything else. ConfigError lists problems by variable
// name only, never values, so it's safe to print.
let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const logger = createLogger({ level: config.logLevel });
const webDistDir = path.resolve(import.meta.dirname, '../../web/dist');

const services = createServices(config, logger);
const app = createApp({
  // Render sets the deployed commit; otherwise this process's start time (a restart is a new build).
  version: process.env.RENDER_GIT_COMMIT?.slice(0, 12) ?? `start-${Date.now()}`,
  webDistDir,
  mockPortal: config.demoCarrierEnabled,
  canary: { token: config.canaryToken, run: () => services.runCanary() },
  api: {
    sessions: services.sessions,
    status: () => services.status(),
    eventsTransport: config.eventsTransport,
    accessCode: config.accessCode,
    logger,
    secureCookies: config.env === 'production',
    cookieKeys: [services.cipher.cookieKey],
  },
});
const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'carrier-docs listening');
});

const shutdown = createShutdown({
  server,
  services,
  logger,
  drainMs: DRAIN_MS,
  hardStopMs: HARD_STOP_MS,
  exit: (code) => process.exit(code),
});

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
