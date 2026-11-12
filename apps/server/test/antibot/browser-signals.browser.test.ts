/**
 * The browser must outlive SIGTERM until the server closes it: on a deploy the server drains its
 * in-flight logins first. Real Chromium in a child process; no network. Skipped unless
 * RUN_BROWSER_TESTS is set.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SIGNALS_LEFT_TO_THE_SERVER } from '../../src/antibot/browser-provider.js';

const run = promisify(execFile);

describe('browser launch and process signals', () => {
  it('leaves SIGTERM, SIGINT and SIGHUP to the server', () => {
    expect(SIGNALS_LEFT_TO_THE_SERVER).toEqual({
      handleSIGTERM: false,
      handleSIGINT: false,
      handleSIGHUP: false,
    });
  });

  it.skipIf(!process.env.RUN_BROWSER_TESTS)(
    'a real browser is still connected after SIGTERM, until the server closes it',
    async () => {
      const child = fileURLToPath(new URL('./fixtures/sigterm-child.ts', import.meta.url));
      const { stdout } = await run(process.execPath, ['--import', 'tsx', child], {
        env: process.env,
        timeout: 30_000,
      });
      expect(JSON.parse(stdout.trim().split('\n').pop() ?? '{}')).toEqual({
        connectedAfterSigterm: true,
      });
    },
    40_000,
  );
});
