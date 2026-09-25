import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import { createDb, createPool, createServer, Engine, runMigrations } from '@mcprouter/core';
import {
  AuditWriter,
  authenticateKey,
  createApp,
  createAuth,
  createRegistry,
  parseConfig,
  resolveTarget,
  startServerSync,
  type ServerSync,
} from '@mcprouter/server';
import { FakeUpstream, fakeFactory } from '../../core/test/fake-upstream.js';
import { addGroup, addUser, createKey, parseGroupAdd, setToolEnabled } from './commands.js';

const log = pino({ level: 'silent' });
let pg: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createPool>;
let engine: Engine;
let sync: ServerSync;
let audit: AuditWriter;
let app: ReturnType<typeof createApp>;
let keyA: string;
let keyB: string;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const parsed = parseConfig({
    DATABASE_URL: pg.getConnectionUri(),
    AUTH_SECRET: 'd'.repeat(32),
    PUBLIC_URL: 'http://hub.test',
    MCPR_SECRET_KEYS: `v1:${Buffer.alloc(32, 7).toString('base64url')}`,
  });
  if (!parsed.ok) throw new Error(parsed.issues.join(','));
  const config = parsed.config;
  pool = createPool(config.databaseUrl);
  await runMigrations(pool, log);
  const db = createDb(pool);
  const auth = createAuth({ db, secret: config.authSecret, baseURL: config.publicUrl.href, log });

  const stdio = { type: 'stdio' as const, command: 'x' };
  await createServer(db, config.secretKeys, { slug: 'fs', config: stdio });
  await createServer(db, config.secretKeys, { slug: 'gh', config: stdio });
  // A: fs (3 tools) + gh=create_issue → 4.  B: fs=read_file,list_dir → 2.
  await addGroup(pool, parseGroupAdd(['eng', '--server', 'fs', '--server', 'gh=create_issue']));
  await addGroup(pool, parseGroupAdd(['ops', '--server', 'fs=read_file,list_dir']));
  await addUser(pool, { email: 'a@x.io', name: 'A', role: 'operator' });
  await addUser(pool, { email: 'b@x.io', name: 'B', role: 'operator' });
  keyA = await createKey(auth, pool, { email: 'a@x.io', name: 'a', groups: ['eng'] });
  keyB = await createKey(auth, pool, { email: 'b@x.io', name: 'b', groups: ['ops'] });

  engine = new Engine({
    logger: log,
    connect: fakeFactory({
      fs: new FakeUpstream('fs', [
        { name: 'read_file' },
        { name: 'write_file' },
        { name: 'list_dir' },
      ]),
      gh: new FakeUpstream('gh', [{ name: 'create_issue' }, { name: 'list_issues' }]),
    }),
  });
  sync = await startServerSync({
    pool,
    db,
    keyring: config.secretKeys,
    engine,
    log,
    intervalMs: 100,
  });
  audit = new AuditWriter({ db, log, intervalMs: 50 });
  audit.start();
  app = createApp({
    config,
    log,
    pool,
    registry: createRegistry(),
    readiness: { migrationsApplied: true, routesMounted: true },
    mcp: {
      authenticate: (h) => authenticateKey(auth, h),
      engine,
      resolve: (t) => resolveTarget(sync.snapshot(), t),
      timeoutMs: 10_000,
      maxInflight: 8,
      audit: (row) => audit.push(row),
      authHandler: (req) => auth.handler(req),
    },
  });
  await vi.waitFor(() => expect(engine.status().every((s) => s.state === 'ready')).toBe(true));
}, 120_000);

afterAll(async () => {
  await audit?.stop();
  sync?.stop();
  await engine?.shutdown();
  await pool?.end();
  await pg?.stop();
});

const rpc = (id: number, method: string, params: unknown = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params });
function post(path: string, key: string, body: string): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body,
  });
}
async function toolNames(path: string, key: string): Promise<string[]> {
  const res = await post(path, key, rpc(1, 'tools/list'));
  const body = (await res.json()) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((t) => t.name).sort();
}

describe('P2 demo — two keys, two groups', () => {
  it('key A lists 4 tools, key B lists 2', async () => {
    expect(await toolNames('/mcp/g/eng', keyA)).toEqual([
      'fs__list_dir',
      'fs__read_file',
      'fs__write_file',
      'gh__create_issue',
    ]);
    expect(await toolNames('/mcp/g/ops', keyB)).toEqual(['fs__list_dir', 'fs__read_file']);
  });

  it("key B on key A's group is 403 insufficient_scope", async () => {
    const res = await post('/mcp/g/eng', keyB, rpc(1, 'tools/list'));
    expect(res.status).toBe(403);
  });

  it('a tool disabled while A holds a stale list fails at CALL time with the one not-found message', async () => {
    await setToolEnabled(pool, { server: 'gh', tool: 'create_issue', enabled: false });
    await vi.waitFor(async () => expect(await toolNames('/mcp/g/eng', keyA)).toHaveLength(3), {
      timeout: 10_000,
    });
    const res = await post(
      '/mcp/g/eng',
      keyA,
      rpc(3, 'tools/call', { name: 'gh__create_issue', arguments: {} }),
    );
    expect(await res.text()).toContain('Tool not found: gh__create_issue');
    await setToolEnabled(pool, { server: 'gh', tool: 'create_issue', enabled: true });
  });

  it('calling an A-only tool with key B is byte-identical to calling a tool that was never defined', async () => {
    const call = rpc(7, 'tools/call', { name: 'fs__write_file', arguments: {} });
    const hidden = await post('/mcp/g/ops', keyB, call);
    const hiddenBytes = await hidden.text();

    // Now make fs__write_file never have existed: remove the server entirely.
    await pool.query(`delete from servers where slug = 'fs'`);
    await vi.waitFor(() => expect(engine.status().map((s) => s.name)).not.toContain('fs'), {
      timeout: 10_000,
    });
    const undefinedCall = await post('/mcp/g/ops', keyB, call);

    expect(hidden.status).toBe(undefinedCall.status);
    expect(hiddenBytes).toBe(await undefinedCall.text());
    expect(hiddenBytes).toContain('Tool not found: fs__write_file');
  });

  it('every call left an audit row with its key and route', async () => {
    await audit.flush();
    const r = await pool.query(
      `select route, item, outcome from audit_event where evt = 'tool.call' order by id`,
    );
    expect(r.rows).toEqual([
      { route: 'g/eng', item: 'gh__create_issue', outcome: 'not_found' },
      { route: 'g/ops', item: 'fs__write_file', outcome: 'not_found' },
      { route: 'g/ops', item: 'fs__write_file', outcome: 'not_found' },
    ]);
  });
});
