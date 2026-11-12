/**
 * Run as a child process by browser-signals.browser.test.ts: launches the browser as the server
 * does, sends itself SIGTERM, and reports whether the browser is still connected a second later
 * (while a real server would be draining its sessions). Prints one JSON line.
 */
import { createBrowserProvider } from '../../../src/antibot/browser-provider.js';

const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
const provider = createBrowserProvider('patched-headless', executablePath ? { executablePath } : {});
const browser = await provider.launch();
// The server's own handler: it decides when the browser closes.
process.on('SIGTERM', () => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ connectedAfterSigterm: browser.isConnected() }) + '\n');
    void browser.close().finally(() => process.exit(0));
  }, 1_000);
});
process.kill(process.pid, 'SIGTERM');
