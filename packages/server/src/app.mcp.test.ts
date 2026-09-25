import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Engine } from '@mcprouter/core';
import { FakeUpstream, fakeFactory } from '../../core/test/fake-upstream.js';
import { API_KEY_ROUTES, createApp, type AuditRow } from './app.js';
import type { KeyAuth } from './auth.js';
import { parseConfig } from './config.js';
import { createRegistry } from './metrics.js';
import { resolveTarget, type Snapshot } from './scope.js';

const FS = '00000000-0000-4000-8000-0000000000f5';
const TEAM = '00000000-0000-4000-8000-0000000000e1';
const snap: Snapshot = {
  servers: [{ id: FS, slug: 'fs', enabled: true }],
  groups: new Map([
    [
      'team',
      {
        id: TEAM,
        members: [
          { serverId: FS, serverSlug: 'fs', tools: 'all', prompts: 'all', resources: 'all' },
        ],
      },
    ],
  ]),
};
const keys: Record<string, KeyAuth> = {
  'Bearer good': { principal: { id: 'u1', isAdmin: false }, keyId: 'k1', grant: { kind: 'all' } },
  'Bearer team': {
    principal: { id: 'u2', isAdmin: false },
    keyId: 'k2',
    grant: { kind: 'groups', ids: [TEAM] },
  },
};
const audited: AuditRow[] = [];
let gate: (() => void) | undefined;
let engine: Engine;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  engine = new Engine({
    logger,
    connect: fakeFactory({
      fs: new FakeUpstream('fs', [
        { name: 'echo', handler: () => 'ok' },
        {
          name: 'hold',
          handler: () =>
            new Promise<string>((r) => {
              gate = () => r('released');
            }),
        },
      ]),
    }),
  });
  await engine.applyConfig([
    { name: 'fs', enabled: true, credentialMode: 'shared', type: 'stdio', command: 'x' },
  ]);
  await vi.waitFor(() => expect(engine.status()[0]?.state).toBe('ready'));

  const r = parseConfig({
    DATABASE_URL: 'postgres://u:p@localhost:5432/d',
    AUTH_SECRET: 'z'.repeat(32),
    PUBLIC_URL: 'http://localhost:3000',
    MCPR_SECRET_KEYS: `v1:${Buffer.alloc(32, 3).toString('base64url')}`,
  });
  if (!r.ok) throw new Error(r.issues.join(','));
  app = createApp({
    config: r.config,
    log: pino({ level: 'silent' }),
    pool: {} as pg.Pool,
    registry: createRegistry(),
    readiness: { migrationsApplied: true, routesMounted: true },
    mcp: {
      authenticate: async (h) => keys[h ?? ''] ?? null,
      engine,
      resolve: (t) => resolveTarget(snap, t),
      timeoutMs: 5_000,
      maxInflight: 1,
      audit: (row) => audited.push(row),
      authHandler: async () => new Response('from-better-auth'),
    },
  });
});

afterAll(() => engine.shutdown());

const KEY = { authorization: 'Bearer good' };

describe('/mcp', () => {
  it('401s without a key, with WWW-Authenticate: Bearer', async () => {
    const res = await app.request('/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('401s a bad key, and a GET without a key', async () => {
    expect(
      (await app.request('/mcp', { method: 'POST', headers: { authorization: 'Bearer bad' } }))
        .status,
    ).toBe(401);
    expect((await app.request('/mcp')).status).toBe(401);
  });

  it.each([
    ['GET', '/mcp'],
    ['DELETE', '/mcp'],
    ['GET', '/mcp/s/fs'],
    ['DELETE', '/mcp/g/team'],
    ['PUT', '/mcp'],
  ])('%s %s → 405 Allow: POST, never an open stream', async (method, path) => {
    const res = await app.request(path, { method, headers: KEY });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(res.headers.get('content-type')).not.toContain('text/event-stream');
  });

  it.each(['/mcp/nope', '/mcp/smart', '/mcp/g/nope', '/mcp/s/nope', '/mcp/g/team/extra'])(
    'POST %s → 404 not_found until its phase',
    async (path) => {
      const res = await app.request(path, { method: 'POST', headers: KEY, body: '{}' });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    },
  );

  it('refuses a body over 4 MB', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { ...KEY, 'content-type': 'application/json' },
      body: 'x'.repeat(4 * 1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });

  it('a real MCP client lists and calls through POST /mcp', async () => {
    const c = new Client({ name: 'test', version: '0.0.0' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        requestInit: { headers: KEY },
        fetch: (url, init) => app.request(String(url), init),
      }),
    );
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['fs__echo', 'fs__hold']);
    const res = await c.callTool({ name: 'fs__echo', arguments: {} });
    expect(JSON.stringify(res.content)).toContain('ok');
    await c.close();
  });
});

describe('/api/auth', () => {
  it.each(API_KEY_ROUTES)('darkens the plugin route %s', async (path) => {
    const res = await app.request(path, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('forwards everything else to better-auth', async () => {
    const res = await app.request('/api/auth/ok');
    expect(await res.text()).toBe('from-better-auth');
  });
});

const rpc = (method: string, params: unknown = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
const post = (path: string, auth: string, body: string) =>
  app.request(path, {
    method: 'POST',
    headers: {
      authorization: auth,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body,
  });

describe('scoped routes', () => {
  it('a group key works on its group route and is 403 insufficient_scope elsewhere', async () => {
    expect((await post('/mcp/g/team', 'Bearer team', rpc('tools/list'))).status).toBe(200);
    for (const path of ['/mcp', '/mcp/s/fs']) {
      const res = await post(path, 'Bearer team', rpc('tools/list'));
      expect(res.status).toBe(403);
      expect(res.headers.get('www-authenticate')).toBe('Bearer error="insufficient_scope"');
    }
  });

  it('an unknown group and an unknown path are the same 404, byte for byte', async () => {
    const a = await post('/mcp/g/nope', 'Bearer good', rpc('tools/list'));
    const b = await post('/mcp/nope', 'Bearer good', rpc('tools/list'));
    expect([a.status, await a.text()]).toEqual([b.status, await b.text()]);
  });

  it('a server route flattens names', async () => {
    const res = await post('/mcp/s/fs', 'Bearer good', rpc('tools/list'));
    expect(JSON.stringify(await res.json())).toContain('"name":"echo"');
  });
});

describe('per-principal concurrency', () => {
  it('the request over the limit gets 429 Retry-After: 1, and the slot frees afterwards', async () => {
    const first = post(
      '/mcp',
      'Bearer good',
      rpc('tools/call', { name: 'fs__hold', arguments: {} }),
    );
    await vi.waitFor(() => expect(gate).toBeDefined());
    const second = await post('/mcp', 'Bearer good', rpc('tools/list'));
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('1');
    // Another principal is not affected.
    expect((await post('/mcp/g/team', 'Bearer team', rpc('tools/list'))).status).toBe(200);
    gate?.();
    expect((await first).status).toBe(200);
    expect((await post('/mcp', 'Bearer good', rpc('tools/list'))).status).toBe(200);
  });
});

describe('audit rows', () => {
  it('each call becomes a row with principal, key and route', async () => {
    audited.length = 0;
    await post(
      '/mcp/g/team',
      'Bearer team',
      rpc('tools/call', { name: 'fs__echo', arguments: { a: 1 } }),
    );
    expect(audited).toEqual([
      expect.objectContaining({
        evt: 'tool.call',
        principalId: 'u2',
        keyId: 'k2',
        route: 'g/team',
        server: 'fs',
        item: 'echo',
        outcome: 'ok',
        inputKeys: ['a'],
      }),
    ]);
  });
});
