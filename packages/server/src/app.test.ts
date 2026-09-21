import { describe, expect, it, beforeEach } from 'vitest';
import { pino } from 'pino';
import type pg from 'pg';
import { createApp, type Readiness } from './app.js';
import { createRegistry } from './metrics.js';
import { parseConfig, type Config } from './config.js';

function cfg(): Config {
  const r = parseConfig({
    DATABASE_URL: 'postgres://u:p@localhost:5432/d',
    AUTH_SECRET: 'z'.repeat(32),
    PUBLIC_URL: 'http://localhost:3000',
  });
  if (!r.ok) throw new Error(r.issues.join(','));
  return r.config;
}

/** A pool stub whose query() outcome the test controls. */
function fakePool(ok: boolean): pg.Pool {
  return {
    query: async () => {
      if (!ok) throw new Error('connection refused');
      return { rows: [{ ok: 1 }], rowCount: 1 };
    },
  } as unknown as pg.Pool;
}

const log = pino({ level: 'silent' });
let readiness: Readiness;

beforeEach(() => {
  readiness = { migrationsApplied: true, routesMounted: true };
});

describe('health', () => {
  it('GET /health/live is 200 without touching the database', async () => {
    const app = createApp({
      config: cfg(),
      log,
      pool: fakePool(false),
      registry: createRegistry(),
      readiness,
    });
    const res = await app.request('/health/live');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('GET /health/ready is 200 when the db answers and migrations are applied', async () => {
    const app = createApp({
      config: cfg(),
      log,
      pool: fakePool(true),
      registry: createRegistry(),
      readiness,
    });
    const res = await app.request('/health/ready');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready', db: true, migrations: true, routes: true });
  });

  it('GET /health/ready is 503 when the database is down', async () => {
    const app = createApp({
      config: cfg(),
      log,
      pool: fakePool(false),
      registry: createRegistry(),
      readiness,
    });
    const res = await app.request('/health/ready');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'not_ready', db: false });
  });

  it('GET /health/ready is 503 before migrations have run', async () => {
    readiness.migrationsApplied = false;
    const app = createApp({
      config: cfg(),
      log,
      pool: fakePool(true),
      registry: createRegistry(),
      readiness,
    });
    const res = await app.request('/health/ready');
    expect(res.status).toBe(503);
  });

  it('never leaks a server name, a version or an error string in a probe body', async () => {
    const app = createApp({
      config: cfg(),
      log,
      pool: fakePool(false),
      registry: createRegistry(),
      readiness,
    });
    const body = await (await app.request('/health/ready')).text();
    expect(body).not.toContain('connection refused');
    expect(body).not.toContain('postgres');
  });
});

describe('correlation', () => {
  it('returns an x-request-id on every response', async () => {
    const app = createApp({
      config: cfg(),
      log,
      pool: fakePool(true),
      registry: createRegistry(),
      readiness,
    });
    const res = await app.request('/health/live');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('two requests get different ids', async () => {
    const app = createApp({
      config: cfg(),
      log,
      pool: fakePool(true),
      registry: createRegistry(),
      readiness,
    });
    const a = (await app.request('/health/live')).headers.get('x-request-id');
    const b = (await app.request('/health/live')).headers.get('x-request-id');
    expect(a).not.toBe(b);
  });
});

describe('metrics', () => {
  it('GET /metrics serves prometheus text', async () => {
    const app = createApp({
      config: cfg(),
      log,
      pool: fakePool(true),
      registry: createRegistry(),
      readiness,
    });
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('process_cpu_user_seconds_total');
    expect(body).toContain('mcprouter_http_requests_total');
  });

  it('counts requests by route and status, not by raw path', async () => {
    const registry = createRegistry();
    const app = createApp({ config: cfg(), log, pool: fakePool(true), registry, readiness });
    await app.request('/health/live');
    await app.request('/health/live');
    const body = await (await app.request('/metrics')).text();
    expect(body).toMatch(/mcprouter_http_requests_total\{[^}]*route="\/health\/live"[^}]*\}\s+2/);
  });

  it('buckets an unknown path as __unmatched__ so a scanner cannot mint series', async () => {
    const registry = createRegistry();
    const app = createApp({ config: cfg(), log, pool: fakePool(true), registry, readiness });
    await app.request('/zzz-not-a-route-1');
    await app.request('/zzz-not-a-route-2');
    const body = await (await app.request('/metrics')).text();
    expect(body).toContain('route="__unmatched__"');
    expect(body).not.toContain('zzz-not-a-route-1');
  });
});
