import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import type { Pool } from 'pg';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { createPool, runMigrations } from './migrate.js';
import * as generated from './schema/auth.js';

// Derived from the generated module, so a table better-auth adds on regeneration is checked too.
const TABLES = Object.values(generated)
  .filter((t) => is(t, PgTable))
  .map((t) => getTableName(t));

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = createPool(pg.getConnectionUri());
  await runMigrations(pool, pino({ level: 'silent' }));
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
});

async function addUser(): Promise<string> {
  const id = randomUUID();
  await pool.query('insert into "user" (id, name, email) values ($1, $2, $3)', [
    id,
    'U',
    `${id}@x.io`,
  ]);
  return id;
}

function addSecret(userId: string | null) {
  return pool.query(
    `insert into secrets (id, scope, user_id, label, key_version, iv, ciphertext, tag)
     values ($1, 'credential', $2, 'K', 1, $3, $4, $5)`,
    [randomUUID(), userId, Buffer.alloc(12), Buffer.alloc(8), Buffer.alloc(16)],
  );
}

describe('better-auth tables', () => {
  it('generates five tables', () => expect(TABLES).toHaveLength(5));

  it.each(TABLES)('creates %s', async (t) => {
    const r = await pool.query('select 1 from information_schema.tables where table_name = $1', [
      t,
    ]);
    expect(r.rowCount).toBe(1);
  });

  it('defaults a new user to the viewer role', async () => {
    const id = await addUser();
    const r = await pool.query('select role from "user" where id = $1', [id]);
    expect(r.rows[0].role).toBe('viewer');
  });
});

describe('secrets.user_id', () => {
  it('rejects a secret for a user that does not exist', async () => {
    await expect(addSecret('nobody')).rejects.toEqual(expect.objectContaining({ code: '23503' }));
  });

  it('goes away with its user', async () => {
    const id = await addUser();
    await addSecret(id);
    await pool.query('delete from "user" where id = $1', [id]);
    const left = await pool.query('select 1 from secrets where user_id = $1', [id]);
    expect(left.rowCount).toBe(0);
  });
});
