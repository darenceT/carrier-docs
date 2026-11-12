import path from 'node:path';
import { createApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './infra/config.js';
import { createLogger } from './infra/logger.js';
import { createServices } from './services.js';

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
  webDistDir,
  mockPortal: config.demoCarrierEnabled,
  canary: { token: config.canaryToken, run: () => services.runCanary() },
  api: {
    sessions: services.sessions,
    status: () => services.status(),
    accessCode: config.accessCode,
    logger,
    secureCookies: config.env === 'production',
    cookieKeys: [services.cipher.cookieKey],
  },
});
const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'carrier-docs listening');
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  // Live sessions end with a retryable failure; their browsers close before the process exits.
  server.closeAllConnections();
  server.close(() => {
    services.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
  // Hard stop if connections linger (Render allows ~30 s on redeploy).
  setTimeout(() => process.exit(1), 25_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
