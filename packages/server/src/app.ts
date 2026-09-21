import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Logger } from 'pino';
import type pg from 'pg';
import { newRequestId, runWithContext } from '@mcprouter/core';
import type { Config } from './config.js';
import type { Metrics } from './metrics.js';

export interface Readiness {
  migrationsApplied: boolean;
  routesMounted: boolean;
}

export interface AppDeps {
  config: Config;
  log: Logger;
  pool: pg.Pool;
  registry: Metrics;
  readiness: Readiness;
  /** Absolute path to the built SPA. Omit to disable static serving. */
  webRoot?: string | undefined;
}

const KNOWN_ROUTES = new Set(['/health/live', '/health/ready', '/metrics']);
const UNMATCHED = '__unmatched__';
const RESERVED = ['/api', '/mcp', '/health', '/metrics', '/.well-known'];

export function createApp(deps: AppDeps): Hono {
  const { log, pool, registry, readiness } = deps;
  const app = new Hono();

  app.use('*', async (c, next) => {
    const ctx = { requestId: newRequestId(), principal: null, server: null };
    const started = process.hrtime.bigint();
    c.header('x-request-id', ctx.requestId);

    await runWithContext(ctx, next);

    const path = new URL(c.req.url).pathname;
    const route = KNOWN_ROUTES.has(path) ? path : UNMATCHED;
    const method = c.req.method;
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;

    registry.httpRequests.inc({ route, method, status: String(c.res.status) });
    registry.httpDuration.observe({ route, method }, seconds);
  });

  /** Liveness: NEVER inspects a dependency — killing the container will not fix Postgres. */
  app.get('/health/live', (c) => c.text('ok'));

  /** Readiness: no server names, no version strings, no error text. */
  app.get('/health/ready', async (c) => {
    let db = false;
    try {
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('timeout')), 2000),
      );
      await Promise.race([pool.query('select 1'), timeout]);
      db = true;
    } catch {
      db = false;
    }

    const ok = db && readiness.migrationsApplied && readiness.routesMounted;
    return c.json(
      {
        status: ok ? 'ready' : 'not_ready',
        db,
        migrations: readiness.migrationsApplied,
        routes: readiness.routesMounted,
      },
      ok ? 200 : 503,
    );
  });

  app.get('/metrics', async (c) => {
    const body = await registry.registry.metrics();
    return c.text(body, 200, { 'content-type': registry.registry.contentType });
  });

  if (deps.webRoot !== undefined) {
    const root = deps.webRoot;
    app.get('*', async (c) => {
      const path = new URL(c.req.url).pathname;
      if (RESERVED.some((p) => path === p || path.startsWith(`${p}/`))) {
        return c.json({ error: 'not_found' }, 404);
      }
      // Assets are content-hashed by vite; index.html must never be cached.
      try {
        const html = await readFile(join(root, 'index.html'), 'utf8');
        return c.html(html, 200, { 'cache-control': 'no-store' });
      } catch {
        return c.json({ error: 'not_found' }, 404);
      }
    });
  }

  app.onError((err, c) => {
    log.error({ evt: 'http.error', err: { message: err.message } }, 'unhandled');
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
