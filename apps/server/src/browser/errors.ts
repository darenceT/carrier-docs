/**
 * Errors that mean the browser (or the page's context) went away under us: the process crashed
 * or was killed, or the pool closed for shutdown. Not the carrier's fault, and worth a retry, so
 * they map to CARRIER_UNAVAILABLE rather than "page changed" or INTERNAL.
 */
const GONE =
  /target page, context or browser has been closed|target closed|browser has been closed|browser (has )?disconnected|browser pool is closed/i;

export function isBrowserGone(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TargetClosedError' || GONE.test(err.message));
}
