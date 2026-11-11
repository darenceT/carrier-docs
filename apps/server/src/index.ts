import path from 'node:path';
import { createApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './infra/config.js';
import { createLogger } from './infra/logger.js';

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

const app = createApp({ webDistDir });
const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'carrier-docs listening');
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  // Hard stop if connections linger (Render allows ~30 s on redeploy).
  setTimeout(() => process.exit(1), 25_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
