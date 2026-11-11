import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import type { Browser, BrowserContext, BrowserContextOptions } from 'patchright';
import { createLogger } from '../../src/infra/logger.js';

/** A fake BrowserContext implementing only what the pool uses. */
export class FakeContext extends EventEmitter {
  closed = false;
  defaultTimeout: number | undefined;
  constructor(readonly options: BrowserContextOptions) {
    super();
  }
  setDefaultTimeout(ms: number): void {
    this.defaultTimeout = ms;
  }
  async storageState(): Promise<unknown> {
    return { cookies: [], origins: [] };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', this);
  }
}

/** A fake Browser implementing only what the pool uses. */
export class FakeBrowser extends EventEmitter {
  closed = false;
  readonly contexts: FakeContext[] = [];
  async newContext(options: BrowserContextOptions = {}): Promise<FakeContext> {
    if (this.closed) throw new Error('browser closed');
    const ctx = new FakeContext(options);
    this.contexts.push(ctx);
    return ctx;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emit('disconnected', this);
  }
  /** Simulate the process dying. */
  crash(): void {
    this.closed = true;
    this.emit('disconnected', this);
  }
}

export const asBrowser = (b: FakeBrowser): Browser => b as unknown as Browser;
export const asFake = (c: BrowserContext): FakeContext => c as unknown as FakeContext;

export function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  return { lines, logger: createLogger({ level: 'debug', destination: stream }) };
}
