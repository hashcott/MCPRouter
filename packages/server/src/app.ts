import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Logger } from 'pino';
import type pg from 'pg';
import {
  currentContext,
  INTEGRITY_BLOCKS,
  newRequestId,
  runWithContext,
  type Engine,
} from '@mcprouter/core';
import type { KeyAuth } from './auth.js';
import type { Config } from './config.js';
import { mountConsole, type ConsoleDeps } from './console/index.js';
import { makeGate } from './gate.js';
import { canSee, checkGrant } from './grant.js';
import { handleMcp, type CallRecord } from './mcp/legacy.js';
import { resolveTarget, type Snapshot, type Target } from './scope.js';
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
  /** Absent: the console REST API is not mounted. */
  console?: ConsoleDeps | undefined;
}

export type AuditRow = CallRecord & {
  /** tools/call outcomes, and console/config changes (`config.*`, `review.*`, `bootstrap.claimed`). */
  evt:
    | 'tool.call'
    | 'integrity.block'
    | 'policy.deny'
    | 'bootstrap.claimed'
    | `config.${string}`
    | `review.${string}`;
  /** Identical denies in one flush window collapse into one row (§11.8). */
  count?: number;
  requestId: string | null;
  principalId: string;
  /** null for a console action: a person with a session, no key involved. */
  keyId: string | null;
  route: string;
};

export interface McpDeps {
  /** `Authorization` header → key principal and grant, or null. */
  authenticate: (authorization: string | undefined) => Promise<KeyAuth | null>;
  engine: Engine;
  /**
   * The current snapshot. Route AND policy are read from the same one per request,
   * so a rule can never be evaluated against a routing table it was not loaded with.
   */
  snapshot: () => Snapshot;
  timeoutMs: number;
  /** Per-principal concurrent MCP requests (§4.2, default 8). */
  maxInflight: number;
  /** §4.2: the largest result returned downstream. */
  resultMaxBytes: number;
  audit: (row: AuditRow) => void;
  /** better-auth's fetch handler. */
  authHandler: (req: Request) => Promise<Response>;
}

/** §5.2: the plugin's client-facing routes. Keys are minted only by our own path. */
export const API_KEY_ROUTES = [
  ...['create', 'get', 'list', 'update', 'delete'].map((r) => `/api/auth/api-key/${r}`),
  // Sign-up is closed (disableSignUp); dark it as well, so it is not even a probe surface.
  '/api/auth/sign-up/email',
];

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

  if (deps.mcp !== undefined) mountMcp(app, deps.mcp, registry);
  if (deps.console !== undefined) mountConsole(app, deps.console);

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

function mountMcp(app: Hono, mcp: McpDeps, metrics: Metrics): void {
  const limit = bodyLimit({
    maxSize: 4 * 1024 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  });
  app.use('/mcp', limit);
  app.use('/mcp/*', limit);

  // Every /mcp route is bearer-authenticated, the 405s and 404s included (§4.2).
  const guarded =
    (handler: (c: Context, a: KeyAuth) => Response | Promise<Response>) =>
    async (c: Context): Promise<Response> => {
      const a = await mcp.authenticate(c.req.header('authorization'));
      if (a === null) {
        return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
      }
      const ctx = currentContext();
      if (ctx !== undefined) ctx.principal = a.principal.id;
      return handler(c, a);
    };

  // A stateless transport answers GET with a 200 event stream that never ends (spike 4).
  const notAllowed = (c: Context): Response =>
    c.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
      405,
      { Allow: 'POST' },
    );

  const inflight = new Map<string, number>();

  // §4.2, in this order: authenticate → resolve + visibility (404) → checkGrant (403) → limit (429) → handle.
  const serve = (target: (c: Context) => Target) =>
    guarded(async (c, a) => {
      const snap = mcp.snapshot();
      const route = resolveTarget(snap, target(c));
      // A group this key cannot see is indistinguishable from one that does not exist.
      if (route === null || !canSee(a.grant, route)) return c.json({ error: 'not_found' }, 404);
      if (checkGrant(a.grant, route) !== 'ok') {
        return c.json({ error: 'insufficient_scope' }, 403, {
          'WWW-Authenticate': 'Bearer error="insufficient_scope"',
        });
      }
      const who = a.principal.id;
      const n = inflight.get(who) ?? 0;
      if (n >= mcp.maxInflight) {
        return c.json({ error: 'too_many_requests' }, 429, { 'Retry-After': '1' });
      }
      inflight.set(who, n + 1);
      try {
        return await handleMcp(c.req.raw, {
          engine: mcp.engine,
          scope: route.scope,
          principal: a.principal,
          timeoutMs: mcp.timeoutMs,
          resultMaxBytes: mcp.resultMaxBytes,
          gate: makeGate({
            rules: snap.policy,
            // The route was resolved against `snap`, but dispatch goes by name to the
            // engine's CURRENT server. If that name now belongs to a different server
            // (deleted and re-created mid-request), evaluate nothing: deny.
            serverIdOf: (name) => {
              const then = snap.servers.find((s) => s.slug === name)?.id;
              const now = mcp.snapshot().servers.find((s) => s.slug === name)?.id;
              return then !== undefined && then === now ? then : undefined;
            },
            subject: { role: a.role, keyId: a.keyId },
            onDecision: (effect) => metrics.policyDecisions.inc({ effect }),
          }),
          audit: (r) => {
            const block =
              r.reason !== undefined && INTEGRITY_BLOCKS.has(r.reason) ? r.reason : undefined;
            const blocked = block !== undefined;
            // Audited and counted — never shown: the caller got the plain not-found (§11.1).
            if (blocked) metrics.integrityBlocks.inc({ reason: block });
            mcp.audit({
              ...r,
              evt: blocked
                ? 'integrity.block'
                : r.outcome === 'denied'
                  ? 'policy.deny'
                  : 'tool.call',
              ...(blocked ? { error: `integrity:${block}` } : {}),
              requestId: currentContext()?.requestId ?? null,
              principalId: who,
              keyId: a.keyId,
              route: route.label,
            });
          },
        });
      } finally {
        const left = (inflight.get(who) ?? 1) - 1;
        if (left === 0) inflight.delete(who);
        else inflight.set(who, left);
      }
    });

  app.post(
    '/mcp',
    serve(() => ({ kind: 'all' })),
  );
  app.post(
    '/mcp/g/:group',
    serve((c) => ({ kind: 'group', slug: c.req.param('group') ?? '' })),
  );
  app.post(
    '/mcp/s/:server',
    serve((c) => ({ kind: 'server', slug: c.req.param('server') ?? '' })),
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
