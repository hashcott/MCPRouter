import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import type { Pool } from 'pg';
import { createPool, runMigrations } from './migrate.js';

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

const violates = (constraint: string) => expect.objectContaining({ code: '23514', constraint });
async function server(): Promise<string> {
  const r = await pool.query(
    `insert into servers (slug, config) values ($1, '{"type":"stdio","command":"x"}') returning id, first_enabled_at`,
    [`s-${randomUUID().slice(0, 8)}`],
  );
  expect(r.rows[0].first_enabled_at).toBeNull();
  return r.rows[0].id;
}

describe('tool_embedding', () => {
  it('holds exactly one of a hash or a defect', async () => {
    const s = await server();
    await pool.query(
      `insert into tool_embedding (server_id, kind, name, def, def_hash, shape_hash) values ($1, 'tool', 'a', '{}', 'h', 'sh')`,
      [s],
    );
    await pool.query(
      `insert into tool_embedding (server_id, kind, name, def, defect) values ($1, 'tool', 'b', '{}', 'too_deep')`,
      [s],
    );
    await expect(
      pool.query(
        `insert into tool_embedding (server_id, kind, name, def) values ($1, 'tool', 'c', '{}')`,
        [s],
      ),
    ).rejects.toEqual(violates('tool_embedding_hash_xor_defect'));
    await expect(
      pool.query(
        `insert into tool_embedding (server_id, kind, name, def, def_hash, shape_hash) values ($1, 'widget', 'd', '{}', 'h', 'h')`,
        [s],
      ),
    ).rejects.toEqual(violates('tool_embedding_kind'));
  });

  it('goes away with its server', async () => {
    const s = await server();
    await pool.query(
      `insert into tool_embedding (server_id, kind, name, def, def_hash, shape_hash) values ($1, 'tool', 'a', '{}', 'h', 'h')`,
      [s],
    );
    await pool.query('delete from servers where id = $1', [s]);
    expect(
      (await pool.query('select 1 from tool_embedding where server_id = $1', [s])).rowCount,
    ).toBe(0);
  });
});

describe('server_item_override review columns', () => {
  it('an approval must carry the hash and the definition it approved', async () => {
    const s = await server();
    await expect(
      pool.query(
        `insert into server_item_override (server_id, kind, item_name, review_state) values ($1, 'tool', 'a', 'approved')`,
        [s],
      ),
    ).rejects.toEqual(violates('server_item_override_approval_complete'));
    await pool.query(
      `insert into server_item_override (server_id, kind, item_name, review_state, approved_hash, approved_def, approved_at)
       values ($1, 'tool', 'a', 'approved', 'h', '{"name":"a"}', now())`,
      [s],
    );
  });

  it('rejects an unknown review state; a rejection needs no hash', async () => {
    const s = await server();
    await expect(
      pool.query(
        `insert into server_item_override (server_id, kind, item_name, review_state) values ($1, 'tool', 'a', 'maybe')`,
        [s],
      ),
    ).rejects.toEqual(violates('server_item_override_review_state'));
    await pool.query(
      `insert into server_item_override (server_id, kind, item_name, review_state) values ($1, 'tool', 'b', 'rejected')`,
      [s],
    );
  });

  it('approved_by is set null when its user is deleted — the approval itself survives', async () => {
    const s = await server();
    const u = randomUUID();
    await pool.query('insert into "user" (id, name, email) values ($1, $2, $3)', [
      u,
      'U',
      `${u}@x.io`,
    ]);
    await pool.query(
      `insert into server_item_override (server_id, kind, item_name, review_state, approved_hash, approved_def, approved_by, approved_at)
       values ($1, 'tool', 'a', 'approved', 'h', '{}', $2, now())`,
      [s, u],
    );
    await pool.query('delete from "user" where id = $1', [u]);
    const r = await pool.query(
      'select review_state, approved_by from server_item_override where server_id = $1',
      [s],
    );
    expect(r.rows[0]).toEqual({ review_state: 'approved', approved_by: null });
  });
});
