import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino, type Logger } from 'pino';
import { createDb, createPool, Engine, runMigrations } from '@mcprouter/core';
import { FakeUpstream, fakeFactory } from '../../core/test/fake-upstream.js';
import { createApp, type AuditRow } from './app.js';
import { authenticateKey, createAuth } from './auth.js';
import { parseConfig } from './config.js';
import { createHash } from 'node:crypto';
import { ensureBootstrap } from './console/bootstrap.js';
import * as ops from './console/ops.js';
import { createRegistry } from './metrics.js';
import { startServerSync, type ServerSync } from './servers-sync.js';

const ORIGIN = 'http://hub.test';
let pg: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createPool>;
let engine: Engine;
let sync: ServerSync;
let app: ReturnType<typeof createApp>;
let token = '';
const audited: AuditRow[] = [];

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const parsed = parseConfig({
    DATABASE_URL: pg.getConnectionUri(),
    AUTH_SECRET: 'c'.repeat(32),
    PUBLIC_URL: ORIGIN,
    MCPR_SECRET_KEYS: `v1:${Buffer.alloc(32, 5).toString('base64url')}`,
    MCPR_INTEGRITY: 'off',
  });
  if (!parsed.ok) throw new Error(parsed.issues.join(','));
  const config = parsed.config;
  pool = createPool(config.databaseUrl);
  const silent = pino({ level: 'silent' });
  await runMigrations(pool, silent);
  const db = createDb(pool);
  // Tests sign in many people quickly; each gets its own (trusted-in-test) client IP bucket.
  const auth = createAuth({
    db,
    secret: config.authSecret,
    baseURL: config.publicUrl.href,
    log: silent,
    clientIpHeader: 'x-test-ip',
  });

  // Capture the one-time token the boot log prints.
  const log = pino({ level: 'silent' });
  log.warn = ((_o: unknown, msg?: string) => {
    token = /"token":"([^"]+)"/.exec(msg ?? '')?.[1] ?? token;
  }) as Logger['warn'];
  await ensureBootstrap(pool, log);

  engine = new Engine({
    logger: silent,
    connect: fakeFactory({
      fs: new FakeUpstream('fs', [{ name: 'read_file' }, { name: 'write_file' }]),
    }),
  });
  sync = await startServerSync({
    pool,
    db,
    keyring: config.secretKeys,
    engine,
    log: silent,
    intervalMs: 50,
    integrity: 'off',
  });
  app = createApp({
    config,
    log: silent,
    pool,
    registry: createRegistry(),
    readiness: { migrationsApplied: true, routesMounted: true },
    mcp: {
      authenticate: (h) => authenticateKey(auth, db, h),
      engine,
      snapshot: () => sync.snapshot(),
      timeoutMs: 10_000,
      maxInflight: 8,
      resultMaxBytes: config.resultMaxBytes,
      audit: (row) => audited.push(row),
      authHandler: (req) => auth.handler(req),
    },
    console: {
      auth,
      db,
      pool,
      engine,
      keyring: config.secretKeys,
      publicUrl: config.publicUrl,
      audit: (row) => audited.push(row),
    },
  });
}, 120_000);

afterAll(async () => {
  sync?.stop();
  await engine?.shutdown();
  await pool?.end();
  await pg?.stop();
});

type Opts = {
  cookie?: string;
  bearer?: string;
  origin?: string | null;
  contentType?: string;
  ip?: string;
};
async function api(method: string, path: string, body?: unknown, o: Opts = {}) {
  const headers: Record<string, string> = {};
  if (o.cookie !== undefined) headers['cookie'] = o.cookie;
  if (o.bearer !== undefined) headers['authorization'] = `Bearer ${o.bearer}`;
  if (o.ip !== undefined) headers['x-test-ip'] = o.ip;
  if (o.origin !== null) headers['origin'] = o.origin ?? ORIGIN;
  if (body !== undefined) headers['content-type'] = o.contentType ?? 'application/json';
  const res = await app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json: json as Record<string, unknown> & unknown[], res };
}
const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
let signIns = 0;
async function signIn(email: string, password: string): Promise<string> {
  const r = await api(
    'POST',
    '/api/auth/sign-in/email',
    { email, password },
    { ip: `203.0.113.${(signIns += 1)}` },
  );
  expect(r.status).toBe(200);
  return cookieOf(r.res);
}

let admin = '';
let operator = '';
let viewer = '';

describe('bootstrap — the first admin, once', () => {
  it('nothing works before it: no sign-up, no session', async () => {
    expect((await api('GET', '/api/me')).status).toBe(401);
    expect(
      (
        await api('POST', '/api/auth/sign-up/email', {
          email: 'x@x.io',
          password: 'p'.repeat(12),
          name: 'X',
        })
      ).status,
    ).toBe(404);
  });

  it('a wrong token is refused and consumes nothing', async () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const r = await api('POST', '/api/bootstrap', {
      token: 'nope',
      email: 'root@x.io',
      name: 'Root',
      password: 'correct horse battery',
    });
    expect(r.status).toBe(403);
  });

  it('the right token creates an admin and signs them in', async () => {
    const r = await api('POST', '/api/bootstrap', {
      token,
      email: 'root@x.io',
      name: 'Root',
      password: 'correct horse battery',
    });
    expect(r.status).toBe(200);
    admin = cookieOf(r.res);
    expect((await api('GET', '/api/me', undefined, { cookie: admin })).json).toMatchObject({
      email: 'root@x.io',
      role: 'admin',
    });
    expect(audited).toContainEqual(expect.objectContaining({ evt: 'bootstrap.claimed' }));
  });

  it('the token works exactly once', async () => {
    const r = await api('POST', '/api/bootstrap', {
      token,
      email: 'second@x.io',
      name: 'Second',
      password: 'correct horse battery',
    });
    expect(r.status).toBe(403);
    const n = await pool.query(`select count(*)::int as n from "user" where role = 'admin'`);
    expect(n.rows[0].n).toBe(1);
  });

  it('with a user present, a reboot removes the token row instead of minting a new one', async () => {
    await ensureBootstrap(pool, pino({ level: 'silent' }));
    const r = await pool.query(`select 1 from system_setting where key = 'bootstrap_admin'`);
    expect(r.rowCount).toBe(0);
  });
});

describe('users (admin) and roles', () => {
  it('an admin creates an operator and a viewer who can sign in', async () => {
    for (const [email, role] of [
      ['op@x.io', 'operator'],
      ['view@x.io', 'viewer'],
    ] as const) {
      const r = await api(
        'POST',
        '/api/users',
        { email, name: role, role, password: 'a long enough pw' },
        { cookie: admin },
      );
      expect(r.status).toBe(201);
    }
    operator = await signIn('op@x.io', 'a long enough pw');
    viewer = await signIn('view@x.io', 'a long enough pw');
    expect((await api('GET', '/api/me', undefined, { cookie: viewer })).json).toMatchObject({
      role: 'viewer',
    });
  });

  it.each([
    ['GET', '/api/users', 'operator'],
    ['POST', '/api/servers', 'viewer'],
    ['POST', '/api/keys', 'viewer'],
    ['POST', '/api/policy', 'operator'],
  ])('%s %s is refused for a %s', async (method, path, who) => {
    const cookie = who === 'viewer' ? viewer : operator;
    const r = await api(method, path, method === 'GET' ? undefined : {}, { cookie });
    expect(r.status).toBe(403);
  });

  it('a duplicate email is a 409, a short password a 400', async () => {
    expect(
      (
        await api(
          'POST',
          '/api/users',
          { email: 'op@x.io', name: 'dup', role: 'viewer', password: 'a long enough pw' },
          { cookie: admin },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await api(
          'POST',
          '/api/users',
          { email: 'short@x.io', name: 's', role: 'viewer', password: 'short' },
          { cookie: admin },
        )
      ).status,
    ).toBe(400);
  });

  it('the last admin can be neither demoted nor deleted; nobody deletes themselves', async () => {
    const me = (await api('GET', '/api/me', undefined, { cookie: admin })).json as { id: string };
    expect(
      (await api('PATCH', `/api/users/${me.id}`, { role: 'viewer' }, { cookie: admin })).status,
    ).toBe(409);
    expect((await api('DELETE', `/api/users/${me.id}`, undefined, { cookie: admin })).status).toBe(
      409,
    );
  });
});

describe('CSRF', () => {
  it('a state-changing request from another origin is refused', async () => {
    expect(
      (
        await api(
          'POST',
          '/api/groups',
          { slug: 'x', members: [] },
          { cookie: operator, origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
  });
  it('a form-encoded body is refused', async () => {
    expect(
      (
        await api('POST', '/api/groups', 'slug=x', {
          cookie: operator,
          contentType: 'application/x-www-form-urlencoded',
        })
      ).status,
    ).toBe(415);
  });
});

describe('the P3 demo, over the API: add a server → build a group → mint a scoped key → paste', () => {
  let key = '';
  let keyId = '';

  it('an operator adds a server; its secret is sealed; viewers can read it', async () => {
    const r = await api(
      'POST',
      '/api/servers',
      { slug: 'fs', config: { type: 'stdio', command: 'x', env: { TOKEN: 'sk-console-1' } } },
      { cookie: operator },
    );
    expect(r.status).toBe(201);
    const dump = await pool.query(`select config::text as c from servers where slug = 'fs'`);
    expect(dump.rows[0].c).not.toContain('sk-console-1');
    await vi.waitFor(async () => {
      const list = (await api('GET', '/api/servers', undefined, { cookie: viewer })).json as {
        slug: string;
        state: string;
      }[];
      expect(list).toEqual([expect.objectContaining({ slug: 'fs', state: 'ready', toolCount: 2 })]);
    });
    expect(audited).toContainEqual(
      expect.objectContaining({ evt: 'config.server.create', server: 'fs', inputKeys: ['TOKEN'] }),
    );
    expect(JSON.stringify(audited)).not.toContain('sk-console-1');
  });

  it('an operator builds a group selecting one tool', async () => {
    const r = await api(
      'POST',
      '/api/groups',
      { slug: 'ro', members: [{ server: 'fs', tools: ['read_file'] }] },
      { cookie: operator },
    );
    expect(r.status).toBe(201);
    expect((await api('GET', '/api/groups', undefined, { cookie: viewer })).json).toEqual([
      { slug: 'ro', members: [{ server: 'fs', alias: null, tools: ['read_file'] }] },
    ]);
  });

  it('mints a key scoped to that group, returning the paste-ready client block — once', async () => {
    const r = await api(
      'POST',
      '/api/keys',
      { name: 'laptop', groups: ['ro'] },
      { cookie: operator },
    );
    expect(r.status).toBe(201);
    const b = r.json as {
      id: string;
      key: string;
      client: { url: string; claudeCode: string; json: unknown };
    };
    key = b.key;
    keyId = b.id;
    expect(b.client.url).toBe(`${ORIGIN}/mcp/g/ro`);
    expect(b.client.claudeCode).toBe(
      `claude mcp add --transport http mcprouter ${ORIGIN}/mcp/g/ro --header "Authorization: Bearer ${key}"`,
    );
    const listed = (await api('GET', '/api/keys', undefined, { cookie: operator })).json as Record<
      string,
      unknown
    >[];
    expect(listed).toEqual([
      expect.objectContaining({
        id: keyId,
        name: 'laptop',
        grant: { kind: 'groups', ids: [expect.any(String)] },
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(key);
  });

  it('the key works on its group route, exposing exactly the selected tool', async () => {
    await vi.waitFor(async () => {
      const res = await app.request('/mcp/g/ro', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      const j = (await res.json()) as { result: { tools: { name: string }[] } };
      expect(j.result.tools.map((t) => t.name)).toEqual(['fs__read_file']);
    });
  });

  it('an API key is never a console credential', async () => {
    expect((await api('GET', '/api/me', undefined, { bearer: key })).status).toBe(401);
    expect((await api('GET', '/api/servers', undefined, { bearer: key })).status).toBe(401);
  });

  it("another operator's key is a 404 to delete; the owner revokes it", async () => {
    expect((await api('DELETE', `/api/keys/${keyId}`, undefined, { cookie: viewer })).status).toBe(
      403,
    );
    expect(
      (await api('DELETE', `/api/keys/${keyId}`, undefined, { cookie: operator })).status,
    ).toBe(200);
    expect((await api('GET', '/api/keys', undefined, { cookie: operator })).json).toEqual([]);
  });

  it('deleting a user revokes every key they own, in the same transaction', async () => {
    const r = await api('POST', '/api/keys', { name: 'doomed' }, { cookie: operator });
    const doomed = (r.json as { key: string }).key;
    const opId = (await pool.query(`select id from "user" where email = 'op@x.io'`)).rows[0].id;
    expect((await api('DELETE', `/api/users/${opId}`, undefined, { cookie: admin })).status).toBe(
      200,
    );
    expect(
      (await pool.query('select 1 from apikey where reference_id = $1', [opId])).rowCount,
    ).toBe(0);
    expect(
      await authenticateKey(
        createAuth({
          db: createDb(pool),
          secret: 'c'.repeat(32),
          baseURL: ORIGIN,
          log: pino({ level: 'silent' }),
        }),
        createDb(pool),
        `Bearer ${doomed}`,
      ),
    ).toBeNull();
  });
});

describe('review over the API', () => {
  it('approve with a stale hash is a 409 carrying the current state; the shown hash approves and records who', async () => {
    await pool.query(
      `insert into tool_embedding (server_id, kind, name, def, def_hash, shape_hash)
       select id, 'tool', 'read_file', '{"name":"read_file"}', repeat('b', 64), repeat('c', 64) from servers where slug = 'fs'
       on conflict (server_id, kind, name) do update set def_hash = excluded.def_hash`,
    );
    const stale = await api(
      'POST',
      '/api/review/approve',
      { server: 'fs', kind: 'tool', name: 'read_file', defHash: 'a'.repeat(64) },
      { cookie: admin },
    );
    expect(stale.status).toBe(409);
    expect((stale.json as { current: { defHash: string } }).current).toMatchObject({
      defHash: 'b'.repeat(64),
    });
    const ok = await api(
      'POST',
      '/api/review/approve',
      { server: 'fs', kind: 'tool', name: 'read_file', defHash: 'b'.repeat(64) },
      { cookie: admin },
    );
    expect(ok.status).toBe(200);
    const row = await pool.query(
      `select o.approved_by = u.id as by_me from server_item_override o, "user" u
       where o.item_name = 'read_file' and u.email = 'root@x.io'`,
    );
    expect(row.rows[0].by_me).toBe(true);
  });
});

describe('policy over the API', () => {
  it('an admin adds a rule and every operator can read it as a sentence', async () => {
    const r = await api(
      'POST',
      '/api/policy',
      { server: 'fs', effect: 'deny', pattern: 'write_*', note: 'read only' },
      { cookie: admin },
    );
    expect(r.status).toBe(201);
    const lines = (await api('GET', '/api/policy', undefined, { cookie: admin })).json as string[];
    expect(lines.join('\n')).toContain(
      'Anyone is DENIED every tool "write_*" on fs — "read only".',
    );
  });

  it('a prompt rule (not enforced yet) and constraints on a deny are refused', async () => {
    expect(
      (
        await api(
          'POST',
          '/api/policy',
          { server: 'fs', effect: 'deny', kind: 'prompt' },
          { cookie: admin },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await api(
          'POST',
          '/api/policy',
          { server: 'fs', effect: 'deny', args: [{ op: 'present', ptr: '/x' }] },
          { cookie: admin },
        )
      ).status,
    ).toBe(400);
  });
});

const tokenRow = (t: string) =>
  pool.query(
    `insert into system_setting (key, value) values ('bootstrap_admin', $1)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify({ hash: createHash('sha256').update(t).digest('hex') })],
  );
const hasTokenRow = async () =>
  (await pool.query(`select 1 from system_setting where key = 'bootstrap_admin'`)).rowCount === 1;

describe('review fixes — the bootstrap token only works on an EMPTY install', () => {
  it('a token still present after users exist (no reboot yet) is refused — and retired', async () => {
    await tokenRow('leaked-from-the-log');
    const r = await api('POST', '/api/bootstrap', {
      token: 'leaked-from-the-log',
      email: 'thief@x.io',
      name: 'T',
      password: 'correct horse battery',
    });
    expect(r.status).toBe(403);
    expect(await hasTokenRow()).toBe(false);
    expect((await pool.query(`select 1 from "user" where email = 'thief@x.io'`)).rowCount).toBe(0);
  });

  it('creating any user (CLI or console) retires the token in the same transaction', async () => {
    await tokenRow('another');
    await ops.addUser(pool, { email: 'cli@x.io', name: 'C', role: 'viewer' });
    expect(await hasTokenRow()).toBe(false);
  });

  it('an oversized body is refused before it is parsed', async () => {
    const r = await api('POST', '/api/bootstrap', { token: 'x'.repeat(100_000) });
    expect(r.status).toBe(413);
  });
});

describe('review fixes — ownership, sessions, errors, policy', () => {
  let op2 = '';
  let op3 = '';

  it('two operators each see and revoke only their own keys', async () => {
    for (const email of ['op2@x.io', 'op3@x.io']) {
      await api(
        'POST',
        '/api/users',
        { email, name: email, role: 'operator', password: 'a long enough pw' },
        { cookie: admin },
      );
    }
    op2 = await signIn('op2@x.io', 'a long enough pw');
    op3 = await signIn('op3@x.io', 'a long enough pw');
    const mine = (await api('POST', '/api/keys', { name: 'op2-key' }, { cookie: op2 })).json as {
      id: string;
    };
    await api('POST', '/api/keys', { name: 'op3-key' }, { cookie: op3 });
    const listed = (await api('GET', '/api/keys', undefined, { cookie: op3 })).json as {
      name: string;
    }[];
    expect(listed.map((k) => k.name)).toEqual(['op3-key']);
    expect((await api('DELETE', `/api/keys/${mine.id}`, undefined, { cookie: op3 })).status).toBe(
      404,
    );
    expect((await api('DELETE', `/api/keys/${mine.id}`, undefined, { cookie: op2 })).status).toBe(
      200,
    );
  });

  it('a demotion reaches the session already open; deleting a user ends their sessions', async () => {
    const id = (await pool.query(`select id from "user" where email = 'op3@x.io'`)).rows[0].id;
    expect(
      (await api('POST', '/api/groups', { slug: 'before', members: [] }, { cookie: op3 })).status,
    ).toBe(201);
    await api('PATCH', `/api/users/${id}`, { role: 'viewer' }, { cookie: admin });
    expect(
      (await api('POST', '/api/groups', { slug: 'after', members: [] }, { cookie: op3 })).status,
    ).toBe(403);
    await api('DELETE', `/api/users/${id}`, undefined, { cookie: admin });
    expect((await api('GET', '/api/me', undefined, { cookie: op3 })).status).toBe(401);
  });

  it('constraint errors wrapped by the driver still map to 409/404, never 500', async () => {
    const dup = await api(
      'POST',
      '/api/servers',
      { slug: 'fs', config: { type: 'stdio', command: 'x' } },
      { cookie: op2 },
    );
    expect(dup.status).toBe(409);
    expect(
      (await api('DELETE', '/api/policy/not-a-uuid', undefined, { cookie: admin })).status,
    ).toBe(404);
  });

  it('an operator cannot delete a server that admin policy targets; an admin can', async () => {
    // The policy tests above left a deny rule on fs.
    const r = await api('DELETE', '/api/servers/fs', undefined, { cookie: op2 });
    expect(r.status).toBe(409);
    expect(
      (
        await pool.query(
          `select 1 from policy_rule p join servers s on s.id = p.server_id where s.slug = 'fs'`,
        )
      ).rowCount,
    ).toBe(1);
    expect((await api('DELETE', '/api/servers/fs', undefined, { cookie: admin })).status).toBe(200);
  });
});
