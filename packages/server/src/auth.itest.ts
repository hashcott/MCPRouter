import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import type { Pool } from 'pg';
import { createDb, createPool, runMigrations, schema } from '@mcprouter/core';
import { authenticateKey, createAuth, KEY_GRANT_ALL, type Auth } from './auth.js';

const log = pino({ level: 'silent' });
let pg: StartedPostgreSqlContainer;
let pool: Pool;
let auth: Auth;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = createPool(pg.getConnectionUri());
  await runMigrations(pool, log);
  auth = createAuth({
    db: createDb(pool),
    secret: 'k'.repeat(32),
    baseURL: 'http://hub.test',
    log,
  });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
});

async function user(role: string): Promise<string> {
  const id = randomUUID();
  await createDb(pool)
    .insert(schema.user)
    .values({ id, name: role, email: `${id}@x.io`, role });
  return id;
}

async function mint(userId: string, permissions?: Record<string, string[]>): Promise<string> {
  const k = await auth.api.createApiKey({
    body: { name: 't', userId, ...(permissions === undefined ? {} : { permissions }) },
  });
  return k.key;
}

describe('authenticateKey', () => {
  it('turns a valid bearer key into its owner', async () => {
    const id = await user('operator');
    const key = await mint(id, KEY_GRANT_ALL);
    expect(key.startsWith('mcpr_')).toBe(true);
    expect(await authenticateKey(auth, `Bearer ${key}`)).toEqual({ id, isAdmin: false });
    expect(await authenticateKey(auth, `bearer ${key}`)).toEqual({ id, isAdmin: false });
  });

  it("an admin's key is not admin", async () => {
    const key = await mint(await user('admin'), KEY_GRANT_ALL);
    expect((await authenticateKey(auth, `Bearer ${key}`))?.isAdmin).toBe(false);
  });

  it.each([
    ['no header', undefined],
    ['empty', ''],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['an unknown key', 'Bearer mcpr_doesnotexist'],
    ['a bare key', 'mcpr_abc'],
  ])('rejects %s', async (_n, header) => {
    expect(await authenticateKey(auth, header)).toBeNull();
  });

  it('rejects a key minted without the P1 grant', async () => {
    const id = await user('operator');
    expect(await authenticateKey(auth, `Bearer ${await mint(id)}`)).toBeNull();
    expect(await authenticateKey(auth, `Bearer ${await mint(id, { mcp: ['read'] })}`)).toBeNull();
  });

  it.each([
    ['an unknown grant', '{"mcp":["admin"]}'],
    ['a widened grant', '{"mcp":["all","admin"]}'],
    ['null', null],
    ['malformed JSON', '{mcp'],
  ])('fails closed on permissions edited to %s', async (_n, raw) => {
    const key = await mint(await user('operator'), KEY_GRANT_ALL);
    await pool.query(
      'update apikey set permissions = $1 where key = (select key from apikey order by created_at desc limit 1)',
      [raw],
    );
    expect(await authenticateKey(auth, `Bearer ${key}`)).toBeNull();
  });

  it('rejects a disabled or expired key', async () => {
    const id = await user('operator');
    const off = await mint(id, KEY_GRANT_ALL);
    await pool.query(`update apikey set enabled = false where start = $1`, [off.slice(0, 6)]);
    expect(await authenticateKey(auth, `Bearer ${off}`)).toBeNull();

    const old = await mint(id, KEY_GRANT_ALL);
    await pool.query(
      `update apikey set expires_at = now() - interval '1 minute' where start = $1`,
      [old.slice(0, 6)],
    );
    expect(await authenticateKey(auth, `Bearer ${old}`)).toBeNull();
  });
});
