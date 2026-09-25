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

async function server(slug: string): Promise<string> {
  const r = await pool.query(
    `insert into servers (slug, config) values ($1, '{"type":"stdio","command":"x"}') returning id`,
    [slug],
  );
  return r.rows[0].id;
}
async function group(slug: string): Promise<string> {
  const r = await pool.query('insert into groups (slug) values ($1) returning id', [slug]);
  return r.rows[0].id;
}

describe('groups', () => {
  it('rejects a slug with the separator', async () => {
    await expect(group('a__b')).rejects.toEqual(violates('groups_slug_fmt'));
  });
});

describe('group_server', () => {
  it('defaults every selection to "all"', async () => {
    const g = await group('g-default');
    const s = await server('s-default');
    await pool.query('insert into group_server (group_id, server_id) values ($1, $2)', [g, s]);
    const r = await pool.query(
      'select tools, prompts, resources from group_server where group_id = $1',
      [g],
    );
    expect(r.rows[0]).toEqual({ tools: 'all', prompts: 'all', resources: 'all' });
  });

  it('rejects a selection that is neither "all" nor an array', async () => {
    const g = await group('g-bad');
    const s = await server('s-bad');
    await expect(
      pool.query(`insert into group_server (group_id, server_id, tools) values ($1, $2, '5')`, [
        g,
        s,
      ]),
    ).rejects.toEqual(violates('group_server_selection'));
  });

  it('rejects an alias with the separator, and a duplicate alias within one group', async () => {
    const g = await group('g-alias');
    const [a, b] = [await server('s-a'), await server('s-b')];
    await expect(
      pool.query(`insert into group_server (group_id, server_id, alias) values ($1, $2, 'x__y')`, [
        g,
        a,
      ]),
    ).rejects.toEqual(violates('group_server_alias_fmt'));
    await pool.query(
      `insert into group_server (group_id, server_id, alias) values ($1, $2, 'same')`,
      [g, a],
    );
    await expect(
      pool.query(`insert into group_server (group_id, server_id, alias) values ($1, $2, 'same')`, [
        g,
        b,
      ]),
    ).rejects.toEqual(expect.objectContaining({ code: '23505' }));
  });

  it('goes away with its group and with its server', async () => {
    const [g1, g2] = [await group('g-c1'), await group('g-c2')];
    const s = await server('s-c');
    await pool.query('insert into group_server (group_id, server_id) values ($1, $3), ($2, $3)', [
      g1,
      g2,
      s,
    ]);
    await pool.query('delete from groups where id = $1', [g1]);
    await pool.query('delete from servers where id = $1', [s]);
    const left = await pool.query('select 1 from group_server where server_id = $1', [s]);
    expect(left.rowCount).toBe(0);
  });
});

describe('server_item_override', () => {
  it('is keyed by (server, kind, bare name) and admits only known kinds', async () => {
    const s = await server('s-o');
    await pool.query(
      `insert into server_item_override (server_id, kind, item_name, enabled) values ($1, 'tool', 'rm', false)`,
      [s],
    );
    await expect(
      pool.query(
        `insert into server_item_override (server_id, kind, item_name) values ($1, 'tool', 'rm')`,
        [s],
      ),
    ).rejects.toEqual(expect.objectContaining({ code: '23505' }));
    await expect(
      pool.query(
        `insert into server_item_override (server_id, kind, item_name) values ($1, 'widget', 'x')`,
        [s],
      ),
    ).rejects.toEqual(violates('server_item_override_kind'));
  });
});

describe('audit_event', () => {
  it('accepts a denormalized row with no foreign keys and survives its server being deleted', async () => {
    const s = await server('s-audit');
    await pool.query(
      `insert into audit_event (evt, principal_id, key_id, route, server, item, outcome, duration_ms, input_keys, input_bytes)
       values ('tool.call', 'u1', 'k1', 'g/team', 's-audit', 'read', 'ok', 12, '{path}', 20)`,
    );
    await pool.query('delete from servers where id = $1', [s]);
    const r = await pool.query(
      `select server, input_keys from audit_event where server = 's-audit'`,
    );
    expect(r.rows).toEqual([{ server: 's-audit', input_keys: ['path'] }]);
  });

  it('rejects an unknown outcome', async () => {
    await expect(
      pool.query(`insert into audit_event (evt, outcome) values ('tool.call', 'meh')`),
    ).rejects.toEqual(violates('audit_event_outcome'));
  });
});
