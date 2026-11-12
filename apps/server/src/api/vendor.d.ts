// Minimal typings for middleware packages that ship without TypeScript declarations.

declare module 'koa-ratelimit' {
  import type { Context, Middleware } from 'koa';

  interface RateLimitOptions {
    driver: 'memory' | 'redis';
    db: Map<unknown, unknown>;
    duration?: number;
    max?: number;
    id?: (ctx: Context) => string | false;
    disableHeader?: boolean;
    errorMessage?: string;
    status?: number;
    throw?: boolean;
    onLimited?: (ctx: Context) => void;
    namespace?: string;
  }

  export default function ratelimit(options: RateLimitOptions): Middleware;
}

declare module 'koa-pino-logger' {
  import type { IncomingMessage, ServerResponse } from 'node:http';
  import type { Middleware } from 'koa';
  import type { Logger } from 'pino';

  interface KoaPinoLoggerOptions {
    logger?: Logger;
    quietReqLogger?: boolean;
    genReqId?: (req: IncomingMessage, res: ServerResponse) => string;
    customProps?: (req: IncomingMessage, res: ServerResponse) => Record<string, unknown>;
  }

  export default function koaPinoLogger(options?: KoaPinoLoggerOptions): Middleware;
}
