import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface RequestContext {
  /** 32 lowercase hex — a valid W3C trace-id. Equals the OTel trace id when OTel is on. */
  readonly requestId: string;
  /** Set once by the auth middleware, after the run has begun. Single writer. */
  principal: string | null;
  /** Set once by the engine at resolution. Single writer. */
  server: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function newRequestId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Only `.run()` is ever used. `.enterWith()` is banned by the oxlint
 * `no-restricted-properties` rule because it leaks a principal across async
 * boundaries — see spec §8 and mcphub userContextService.ts:28,38.
 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}
