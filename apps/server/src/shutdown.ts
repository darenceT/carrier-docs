import type { Logger } from 'pino';

export interface ShutdownDeps {
  server: { close(callback: () => void): void; closeAllConnections(): void };
  services: { drain(timeoutMs: number): Promise<void>; close(): Promise<void> };
  logger: Logger;
  /** How long in-flight logins get to finish. */
  drainMs: number;
  /** Exit no matter what after this long (before the platform's own kill). */
  hardStopMs: number;
  exit(code: number): void;
}

/** Render waits 30 s after SIGTERM before it kills the process. */
export const DRAIN_MS = 25_000;
export const HARD_STOP_MS = 29_000;

/**
 * Graceful shutdown on SIGTERM (a redeploy) or SIGINT:
 *   1. drain   no new logins (BUSY), queued ones end, in-flight ones get `drainMs` to finish. The
 *              server keeps answering meanwhile, so an MFA code or a document request for a
 *              session still running here is served.
 *   2. stop    close the HTTP server and every open connection (event streams included).
 *   3. close   sessions, browser and store.
 *   4. exit    after flushing the logs. A hard stop at `hardStopMs` covers anything that hangs.
 * Repeated signals are ignored.
 */
export function createShutdown(d: ShutdownDeps): (signal: string) => Promise<void> {
  let stopping = false;
  return async (signal) => {
    if (stopping) return;
    stopping = true;
    const hardStop = setTimeout(() => {
      d.logger.error({ signal }, 'shutdown took too long; exiting');
      flush(d.logger);
      d.exit(1);
    }, d.hardStopMs);
    hardStop.unref?.();

    let code = 0;
    d.logger.info({ signal, drainMs: d.drainMs }, 'shutting down: draining sessions');
    try {
      await d.services.drain(d.drainMs);
    } catch (err) {
      code = 1;
      d.logger.error({ err }, 'drain failed');
    }
    const closed = new Promise<void>((resolve) => d.server.close(() => resolve()));
    d.server.closeAllConnections();
    await closed;
    try {
      await d.services.close();
    } catch (err) {
      code = 1;
      d.logger.error({ err }, 'closing services failed');
    }
    clearTimeout(hardStop);
    d.logger.info({ signal }, 'shutdown complete');
    flush(d.logger);
    d.exit(code);
  };
}

function flush(logger: Logger): void {
  try {
    logger.flush();
  } catch {
    // Exiting anyway.
  }
}
