import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Engine, type Principal, type ResolvedScope } from '@mcprouter/core';
import { FakeUpstream, fakeFactory } from '../../core/test/fake-upstream.js';
import { API_KEY_ROUTES, createApp } from './app.js';
import { parseConfig } from './config.js';
import { createRegistry } from './metrics.js';

const principal: Principal = { id: 'u1', isAdmin: false };
const scope: ResolvedScope = {
  key: 'all:fs',
  servers: [{ serverName: 'fs', tools: 'all', prompts: 'all', resources: 'all' }],
  flatten: false,
};
let engine: Engine;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  engine = new Engine({
    logger,
    connect: fakeFactory({ fs: new FakeUpstream('fs', [{ name: 'echo', handler: () => 'ok' }]) }),
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
      authenticate: async (h) => (h === 'Bearer good' ? principal : null),
      engine,
      scopeAll: () => scope,
      timeoutMs: 5_000,
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

  it.each(['/mcp/nope', '/mcp/g/team', '/mcp/s/fs', '/mcp/smart'])(
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
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['fs__echo']);
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
