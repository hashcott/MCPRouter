import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import { createPool, runMigrations, MIGRATION_LOCK_ID } from './migrate.js';

const log = pino({ level: 'silent' });
let pg: StartedPostgreSqlContainer;
let url: string;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  url = pg.getConnectionUri();
}, 120_000);

afterAll(async () => {
  await pg?.stop();
});

describe('migrations', () => {
  it('creates the schema and the vector extension', async () => {
    const pool = createPool(url);
    await runMigrations(pool, log);

    const ext = await pool.query("select 1 from pg_extension where extname = 'vector'");
    expect(ext.rowCount).toBe(1);

    const tbl = await pool.query(
      "select 1 from information_schema.tables where table_name = 'system_setting'",
    );
    expect(tbl.rowCount).toBe(1);

    await pool.end();
  });

  it('is idempotent — a second run is a no-op', async () => {
    const pool = createPool(url);
    await runMigrations(pool, log);
    await runMigrations(pool, log);
    const tbl = await pool.query(
      "select count(*)::int as n from information_schema.tables where table_name = 'system_setting'",
    );
    expect(tbl.rows[0]?.n).toBe(1);
    await pool.end();
  });

  it('serialises concurrent runners with the advisory lock', async () => {
    const a = createPool(url);
    const b = createPool(url);
    await Promise.all([runMigrations(a, log), runMigrations(b, log)]);

    // The lock must be released by both.
    const held = await a.query('select count(*)::int as n from pg_locks where locktype = $1', [
      'advisory',
    ]);
    expect(held.rows[0]?.n).toBe(0);

    await a.end();
    await b.end();
  });

  it('uses a stable, non-zero lock id', () => {
    expect(Number.isInteger(MIGRATION_LOCK_ID)).toBe(true);
    expect(MIGRATION_LOCK_ID).not.toBe(0);
  });
});
