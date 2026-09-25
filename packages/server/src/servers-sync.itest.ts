import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino, type Logger } from 'pino';
import type { Pool } from 'pg';
import {
  createDb,
  createPool,
  createServer,
  Engine,
  parseKeyring,
  runMigrations,
  type Db,
} from '@mcprouter/core';
import { FakeUpstream, fakeFactory } from '../../core/test/fake-upstream.js';
import { resolveTarget } from './scope.js';
import { startServerSync, type ServerSync } from './servers-sync.js';

const kr = parseKeyring(`v1:${Buffer.alloc(32, 1).toString('base64url')}`);
const stdio = (env: Record<string, string> = {}) => ({ type: 'stdio' as const, command: 'x', env });
const names = (s: ServerSync) =>
  resolveTarget(s.snapshot(), { kind: 'all' })?.scope.servers.map((x) => x.serverName) ?? [];

let pg: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let engine: Engine;
let sync: ServerSync;
const errors: unknown[] = [];

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = createPool(pg.getConnectionUri());
  await runMigrations(pool, pino({ level: 'silent' }));
  db = createDb(pool);
  engine = new Engine({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    connect: fakeFactory({
      fs: new FakeUpstream('fs', [{ name: 't' }]),
      gh: new FakeUpstream('gh', [{ name: 't' }]),
      off: new FakeUpstream('off', [{ name: 't' }]),
    }),
  });
  const log = pino({ level: 'silent' });
  log.error = ((o: unknown) => void errors.push(o)) as Logger['error'];
  await createServer(db, kr, { slug: 'fs', config: stdio() });
  sync = await startServerSync({ pool, db, keyring: kr, engine, log, intervalMs: 50 });
}, 120_000);

afterAll(async () => {
  sync?.stop();
  await engine?.shutdown();
  await pool?.end();
  await pg?.stop();
});

describe('startServerSync', () => {
  it('applies the table before it resolves', () => {
    expect(names(sync)).toEqual(['fs']);
    expect(engine.status().map((s) => s.name)).toEqual(['fs']);
    expect(resolveTarget(sync.snapshot(), { kind: 'all' })?.scope.flatten).toBe(false);
  });

  it('picks up a server added while it runs', async () => {
    await createServer(db, kr, { slug: 'gh', config: stdio() });
    await vi.waitFor(() => expect(names(sync)).toEqual(['fs', 'gh']));
  });

  it('keeps a disabled server out of the scope', async () => {
    await createServer(db, kr, { slug: 'off', enabled: false, config: stdio() });
    await vi.waitFor(() => expect(engine.status().map((s) => s.name)).toContain('off'));
    expect(names(sync)).not.toContain('off');
  });

  it('drops a deleted server', async () => {
    await pool.query(`delete from servers where slug = 'gh'`);
    await vi.waitFor(() => expect(names(sync)).toEqual(['fs']));
    expect(engine.status().map((s) => s.name)).not.toContain('gh');
  });

  it('sees an in-place edit made with raw SQL, no updated_at bump needed', async () => {
    await pool.query(`update servers set enabled = false where slug = 'fs'`);
    await vi.waitFor(() => expect(names(sync)).not.toContain('fs'));
    await pool.query(`update servers set enabled = true where slug = 'fs'`);
    await vi.waitFor(() => expect(names(sync)).toContain('fs'));
  });

  it('logs a server whose secret cannot be opened, by slug, and keeps serving the rest', async () => {
    await createServer(db, kr, { slug: 'broken', config: stdio({ K: 'v' }) });
    await pool.query(`update secrets set tag = decode(repeat('00', 16), 'hex') where label = 'K'`);
    await vi.waitFor(() =>
      expect(errors).toContainEqual(expect.objectContaining({ server: 'broken' })),
    );
    expect(names(sync)).toEqual(['fs']);
  });
});

describe('groups in the snapshot', () => {
  it('a group added while running resolves with its members and selections', async () => {
    const g = await pool.query(`insert into groups (slug) values ('team') returning id`);
    await pool.query(
      `insert into group_server (group_id, server_id, tools, prompts, resources)
       select $1, id, '["t"]', '[]', '[]' from servers where slug = 'fs'`,
      [g.rows[0].id],
    );
    await vi.waitFor(() =>
      expect(
        resolveTarget(sync.snapshot(), { kind: 'group', slug: 'team' })?.scope.servers,
      ).toEqual([{ serverName: 'fs', tools: ['t'], prompts: [], resources: [] }]),
    );
  });

  it('a group with no members resolves empty', async () => {
    await pool.query(`insert into groups (slug) values ('nobody')`);
    await vi.waitFor(() =>
      expect(resolveTarget(sync.snapshot(), { kind: 'group', slug: 'nobody' })?.serverIds).toEqual(
        [],
      ),
    );
  });

  it('a malformed selection edited by hand exposes nothing for that member, and the group still resolves', async () => {
    // The CHECK admits any array; an array of non-strings is still wrong.
    await pool.query(
      `update group_server set tools = '[1, 2]' where group_id = (select id from groups where slug = 'team')`,
    );
    await vi.waitFor(() =>
      expect(
        resolveTarget(sync.snapshot(), { kind: 'group', slug: 'team' })?.scope.servers[0]?.tools,
      ).toEqual([]),
    );
  });
});
