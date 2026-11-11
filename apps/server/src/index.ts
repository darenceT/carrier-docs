import path from 'node:path';
import { createApp } from './app.js';

// Minimal env handling for Phase 1. Phase 3 replaces this with zod-validated config.
const port = Number(process.env.PORT ?? 3000);
const dataDir = process.env.DATA_DIR ?? path.resolve('data');
const webDistDir = path.resolve(import.meta.dirname, '../../web/dist');

const app = createApp({ dataDir, webDistDir });
const server = app.listen(port, () => {
  console.log(`carrier-docs listening on :${port}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, closing server`);
  server.close(() => process.exit(0));
  // Hard stop if connections linger (Render allows ~30 s on redeploy).
  setTimeout(() => process.exit(1), 25_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
