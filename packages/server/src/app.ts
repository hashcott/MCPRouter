import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Logger } from 'pino';
import type pg from 'pg';
import {
  currentContext,
  newRequestId,
  runWithContext,
  type Engine,
  type Principal,
  type ResolvedScope,
} from '@mcprouter/core';
import type { Config } from './config.js';
import { handleMcp } from './mcp/legacy.js';
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
  /** Absent: the MCP surface and /api/auth are not mounted. */
  mcp?: McpDeps | undefined;
}

export interface McpDeps {
  /** `Authorization` header → machine principal, or null. */
  authenticate: (authorization: string | undefined) => Promise<Principal | null>;
  engine: Engine;
  /** The `{kind:'all'}` target (§4.2): every enabled server currently loaded. */
  scopeAll: () => ResolvedScope;
  timeoutMs: number;
  /** better-auth's fetch handler. */
  authHandler: (req: Request) => Promise<Response>;
}

/** §5.2: the plugin's client-facing routes. Keys are minted only by our own path. */
export const API_KEY_ROUTES = ['create', 'get', 'list', 'update', 'delete'].map(
  (r) => `/api/auth/api-key/${r}`,
);

const KNOWN_ROUTES = new Set(['/health/live', '/health/ready', '/metrics', '/mcp']);
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

  if (deps.mcp !== undefined) mountMcp(app, deps.mcp);

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

function mountMcp(app: Hono, mcp: McpDeps): void {
  const limit = bodyLimit({
    maxSize: 4 * 1024 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  });
  app.use('/mcp', limit);
  app.use('/mcp/*', limit);

  // Every /mcp route is bearer-authenticated, the 405s and 404s included (§4.2).
  const guarded =
    (handler: (c: Context, p: Principal) => Response | Promise<Response>) =>
    async (c: Context): Promise<Response> => {
      const principal = await mcp.authenticate(c.req.header('authorization'));
      if (principal === null) {
        return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
      }
      const ctx = currentContext();
      if (ctx !== undefined) ctx.principal = principal.id;
      return handler(c, principal);
    };

  // A stateless transport answers GET with a 200 event stream that never ends (spike 4).
  const notAllowed = (c: Context): Response =>
    c.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
      405,
      { Allow: 'POST' },
    );

  app.post(
    '/mcp',
    guarded((c, principal) =>
      handleMcp(c.req.raw, {
        engine: mcp.engine,
        scope: mcp.scopeAll(),
        principal,
        timeoutMs: mcp.timeoutMs,
      }),
    ),
  );
  app.on(['GET', 'DELETE'], ['/mcp', '/mcp/*'], guarded(notAllowed));
  // Before the /mcp/* catch-all: Hono's `/mcp/*` also matches `/mcp` itself.
  app.all('/mcp', guarded(notAllowed));
  app.all(
    '/mcp/*',
    guarded((c) => c.json({ error: 'not_found' }, 404)),
  );

  for (const path of API_KEY_ROUTES) app.all(path, (c) => c.json({ error: 'not_found' }, 404));
  app.on(['GET', 'POST'], '/api/auth/*', (c) => mcp.authHandler(c.req.raw));
}
