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
import { startServerSync, type ServerSync } from './servers-sync.js';

const kr = parseKeyring(`v1:${Buffer.alloc(32, 1).toString('base64url')}`);
const stdio = (env: Record<string, string> = {}) => ({ type: 'stdio' as const, command: 'x', env });
const names = (s: ServerSync) => s.scopeAll().servers.map((x) => x.serverName);

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
    expect(sync.scopeAll().flatten).toBe(false);
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

  it('logs a server whose secret cannot be opened, by slug, and keeps serving the rest', async () => {
    await createServer(db, kr, { slug: 'broken', config: stdio({ K: 'v' }) });
    await pool.query(`update secrets set tag = decode(repeat('00', 16), 'hex') where label = 'K'`);
    await pool.query(`update servers set updated_at = now() where slug = 'broken'`);
    await vi.waitFor(() =>
      expect(errors).toContainEqual(expect.objectContaining({ server: 'broken' })),
    );
    expect(names(sync)).toEqual(['fs']);
  });
});
