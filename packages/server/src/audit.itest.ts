import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import type { Pool } from 'pg';
import { createDb, createPool, runMigrations } from '@mcprouter/core';
import type { AuditRow } from './app.js';
import { AuditWriter } from './audit.js';

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

const row = (item: string): AuditRow => ({
  evt: 'tool.call',
  requestId: 'r1',
  principalId: 'u1',
  keyId: 'k1',
  route: 'g/team',
  server: 'fs',
  item,
  outcome: 'ok',
  durationMs: 3,
  inputKeys: ['path'],
  inputBytes: 10,
  error: null,
});

describe('AuditWriter', () => {
  it('flushes on the timer, in one multi-row insert', async () => {
    const w = new AuditWriter({
      db: createDb(pool),
      log: pino({ level: 'silent' }),
      intervalMs: 20,
    });
    w.start();
    w.push(row('a'));
    w.push(row('b'));
    await vi.waitFor(async () => {
      const r = await pool.query(`select item, input_keys, route from audit_event order by id`);
      expect(r.rows).toEqual([
        { item: 'a', input_keys: ['path'], route: 'g/team' },
        { item: 'b', input_keys: ['path'], route: 'g/team' },
      ]);
    });
    await w.stop();
  });

  it('flushes as soon as a batch fills, without waiting for the timer', async () => {
    await pool.query('delete from audit_event');
    const w = new AuditWriter({
      db: createDb(pool),
      log: pino({ level: 'silent' }),
      batch: 2,
      intervalMs: 60_000,
    });
    w.push(row('x'));
    w.push(row('y'));
    await vi.waitFor(async () => {
      const r = await pool.query('select count(*)::int as n from audit_event');
      expect(r.rows[0].n).toBe(2);
    });
    await w.stop();
  });

  it('stop() drains the queue', async () => {
    await pool.query('delete from audit_event');
    const w = new AuditWriter({
      db: createDb(pool),
      log: pino({ level: 'silent' }),
      intervalMs: 60_000,
    });
    w.push(row('z'));
    await w.stop();
    const r = await pool.query('select count(*)::int as n from audit_event');
    expect(r.rows[0].n).toBe(1);
  });
});
