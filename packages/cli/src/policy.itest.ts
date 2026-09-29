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
  startServerSync,
  type ServerSync,
} from '@mcprouter/server';
import { FakeUpstream, fakeFactory } from '../../core/test/fake-upstream.js';
import {
  addPolicy,
  addUser,
  CliError,
  createKey,
  listPolicies,
  parsePolicyAdd,
  removePolicy,
} from './commands.js';

const log = pino({ level: 'silent' });
let pg: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createPool>;
let engine: Engine;
let sync: ServerSync;
let audit: AuditWriter;
let registry: ReturnType<typeof createRegistry>;
let app: ReturnType<typeof createApp>;
let viewerKey: string;
let operatorKey: string;
const upstreamSaw: unknown[] = [];

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const parsed = parseConfig({
    DATABASE_URL: pg.getConnectionUri(),
    AUTH_SECRET: 'd'.repeat(32),
    PUBLIC_URL: 'http://hub.test',
    MCPR_SECRET_KEYS: `v1:${Buffer.alloc(32, 7).toString('base64url')}`,
    MCPR_INTEGRITY: 'off',
  });
  if (!parsed.ok) throw new Error(parsed.issues.join(','));
  const config = parsed.config;
  pool = createPool(config.databaseUrl);
  await runMigrations(pool, log);
  const db = createDb(pool);
  const auth = createAuth({ db, secret: config.authSecret, baseURL: config.publicUrl.href, log });
  await createServer(db, config.secretKeys, {
    slug: 'fs',
    config: { type: 'stdio', command: 'x' },
  });
  await addUser(pool, { email: 'v@x.io', name: 'V', role: 'viewer' });
  await addUser(pool, { email: 'o@x.io', name: 'O', role: 'operator' });
  viewerKey = await createKey(auth, pool, { email: 'v@x.io', name: 'v' });
  operatorKey = await createKey(auth, pool, { email: 'o@x.io', name: 'o' });

  const record = (name: string) => (args: Record<string, unknown>) => {
    upstreamSaw.push({ name, args });
    return `${name} ok`;
  };
  // One upstream, reachable under both names the server will have during the rename test.
  const fs = new FakeUpstream('fs', [
    { name: 'read_file', handler: record('read_file') },
    { name: 'write_file', handler: record('write_file') },
  ]);
  engine = new Engine({ logger: log, connect: fakeFactory({ fs, files: fs }) });
  sync = await startServerSync({
    pool,
    db,
    keyring: config.secretKeys,
    engine,
    log,
    intervalMs: 50,
    integrity: 'off',
  });
  audit = new AuditWriter({ db, log, intervalMs: 50 });
  audit.start();
  registry = createRegistry({ policyCheckedAt: () => sync.lastOkAt() });
  app = createApp({
    config,
    log,
    pool,
    registry,
    readiness: { migrationsApplied: true, routesMounted: true },
    mcp: {
      authenticate: (h) => authenticateKey(auth, db, h),
      engine,
      snapshot: () => sync.snapshot(),
      timeoutMs: 10_000,
      maxInflight: 8,
      resultMaxBytes: config.resultMaxBytes,
      audit: (row) => audit.push(row),
      authHandler: (req) => auth.handler(req),
    },
  });
  await vi.waitFor(() => expect(engine.status()[0]?.state).toBe('ready'));
}, 120_000);

afterAll(async () => {
  await audit?.stop();
  sync?.stop();
  await engine?.shutdown();
  await pool?.end();
  await pg?.stop();
});

const call = async (key: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  return { isError: body.result.isError === true, text: body.result.content[0]?.text ?? '' };
};
/** Wait until the poller has applied EXACTLY these rules (a count can match a stale snapshot). */
const settle = (ids: string[]) =>
  vi.waitFor(() =>
    expect(
      sync
        .snapshot()
        .policy.map((r) => r.id)
        .sort(),
    ).toEqual([...ids].sort()),
  );

describe('P2c — policy rules, first match, role from the owner', () => {
  let viewerDeny: string;
  let allowId: string;

  it('no rule: everything is allowed (policy is purely subtractive)', async () => {
    expect(await call(viewerKey, 'fs__write_file')).toEqual({
      isError: false,
      text: 'write_file ok',
    });
  });

  it("a role rule matches that role's API keys — the note reaches the caller; the upstream never sees the call", async () => {
    viewerDeny = await addPolicy(
      pool,
      parsePolicyAdd([
        'fs',
        '--deny',
        '--name',
        'write_*',
        '--role',
        'viewer',
        '--note',
        'viewers are read-only',
      ]),
    );
    await settle([viewerDeny]);
    upstreamSaw.length = 0;
    expect(await call(viewerKey, 'fs__write_file')).toEqual({
      isError: true,
      text: 'Denied by policy: viewers are read-only',
    });
    expect(upstreamSaw).toEqual([]);
    expect(await call(viewerKey, 'fs__read_file')).toEqual({
      isError: false,
      text: 'read_file ok',
    });
    expect(await call(operatorKey, 'fs__write_file')).toEqual({
      isError: false,
      text: 'write_file ok',
    });
  });

  it("a demotion reaches a key minted before it: the operator's key is denied the moment they become a viewer", async () => {
    await pool.query(`update "user" set role = 'viewer' where email = 'o@x.io'`);
    expect((await call(operatorKey, 'fs__write_file')).isError).toBe(true);
    await pool.query(`update "user" set role = 'operator' where email = 'o@x.io'`);
  });

  it('renaming the server keeps the rule (it targets the server id, not its slug)', async () => {
    await pool.query(`update servers set slug = 'files' where slug = 'fs'`);
    await vi.waitFor(async () =>
      expect((await call(viewerKey, 'files__read_file')).isError).toBe(false),
    );
    expect((await call(viewerKey, 'files__write_file')).text).toBe(
      'Denied by policy: viewers are read-only',
    );
    await pool.query(`update servers set slug = 'fs' where slug = 'files'`);
    await vi.waitFor(async () =>
      expect((await call(viewerKey, 'fs__read_file')).isError).toBe(false),
    );
  });

  it('a constrained allow: only paths under /srv/data; anything else fails CLOSED', async () => {
    await removePolicy(pool, viewerDeny);
    allowId = await addPolicy(
      pool,
      parsePolicyAdd([
        'fs',
        '--allow',
        '--name',
        'write_file',
        '--arg',
        'pathUnder:/path=/srv/data',
        '--note',
        'data dir only',
      ]),
    );
    await settle([allowId]);
    upstreamSaw.length = 0;
    expect((await call(operatorKey, 'fs__write_file', { path: '/srv/data/a.txt' })).isError).toBe(
      false,
    );
    expect(
      await call(operatorKey, 'fs__write_file', { path: '/srv/data/../../etc/passwd' }),
    ).toEqual({
      isError: true,
      text: 'Denied by policy: data dir only',
    });
    expect((await call(operatorKey, 'fs__write_file', {})).isError).toBe(true);
    expect(
      (await call(operatorKey, 'fs__write_file', { path: ['/srv/data/a', '/etc'] })).isError,
    ).toBe(true);
    // Exactly the one allowed call reached the upstream — with exactly the checked arguments.
    expect(upstreamSaw).toEqual([{ name: 'write_file', args: { path: '/srv/data/a.txt' } }]);
  });

  it('an expired break-glass deny switches itself off', async () => {
    const expired = await addPolicy(
      pool,
      parsePolicyAdd([
        'fs',
        '--deny',
        '--name',
        'read_file',
        '--seq',
        '1',
        '--expires',
        '2026-01-01T00:00:00Z',
      ]),
    );
    await settle([allowId, expired]);
    expect((await call(viewerKey, 'fs__read_file')).isError).toBe(false);
  });

  it('policy list renders every rule as a sentence and warns about shadowing', async () => {
    await addPolicy(pool, parsePolicyAdd(['fs', '--allow', '--seq', '2']));
    await addPolicy(pool, parsePolicyAdd(['fs', '--deny', '--name', 'rm_*', '--seq', '3']));
    const lines = await listPolicies(pool);
    expect(lines.join('\n')).toContain('Anyone is ALLOWED every tool items on fs.');
    expect(lines.join('\n')).toContain(
      'only when /path is a path under /srv/data (lexical: symlinks are not resolved)',
    );
    expect(lines.join('\n')).toContain('[expired]');
    expect(lines.some((l) => l.startsWith('WARNING:') && l.includes('never matches'))).toBe(true);
  });

  it('denies are audited as policy.deny, coalesced with a count, and counted by effect', async () => {
    await audit.flush();
    const r = await pool.query(
      `select item, count, error from audit_event where evt = 'policy.deny' order by id`,
    );
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((x) => /^policy:/.test(x.error))).toBe(true);
    const metrics = await registry.registry.getSingleMetricAsString(
      'mcprouter_policy_decision_total',
    );
    expect(metrics).toMatch(/effect="deny"} \d+/);
    expect(metrics).toMatch(/effect="allow"} \d+/);
    expect(
      await registry.registry.getSingleMetricAsString('mcprouter_policy_snapshot_age_seconds'),
    ).toMatch(/mcprouter_policy_snapshot_age_seconds \d/);
  });

  it('a key-scoped rule must name a key that exists; a real one matches only that key', async () => {
    await expect(
      addPolicy(pool, parsePolicyAdd(['fs', '--deny', '--key', 'no-such-key'])),
    ).rejects.toBeInstanceOf(CliError);
    const viewerKeyId = (
      await pool.query(
        `select a.id from apikey a join "user" u on u.id = a.reference_id where u.email = 'v@x.io'`,
      )
    ).rows[0].id;
    await addPolicy(
      pool,
      parsePolicyAdd([
        'fs',
        '--deny',
        '--name',
        'read_file',
        '--key',
        viewerKeyId,
        '--seq',
        '0',
        '--note',
        'this key only',
      ]),
    );
    await vi.waitFor(async () =>
      expect((await call(viewerKey, 'fs__read_file')).text).toBe('Denied by policy: this key only'),
    );
    expect((await call(operatorKey, 'fs__read_file')).isError).toBe(false);
  });
});
