import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import type { Pool } from 'pg';
import { createPool, runMigrations } from './migrate.js';

let pg: StartedPostgreSqlContainer;
let pool: Pool;
let serverId: string;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = createPool(pg.getConnectionUri());
  await runMigrations(pool, pino({ level: 'silent' }));
  const r = await pool.query(
    `insert into servers (slug, config) values ('fs', '{"type":"stdio","command":"x"}') returning id`,
  );
  serverId = r.rows[0].id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
});

const violates = (constraint: string) => expect.objectContaining({ code: '23514', constraint });
let seq = 1_000;
function add(over: Record<string, unknown> = {}) {
  const row = {
    seq: (seq += 10),
    subject_kind: 'any',
    subject_id: null,
    server_id: serverId,
    effect: 'deny',
    args: '[]',
    name_pattern: '*',
    ...over,
  };
  const cols = Object.keys(row);
  return pool.query(
    `insert into policy_rule (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(row),
  );
}

describe('policy_rule constraints', () => {
  it('accepts a plain deny and a constrained allow', async () => {
    await add();
    await add({ effect: 'allow', args: '[{"op":"present","ptr":"/path"}]' });
  });

  it.each([
    ['a subject id without a narrow subject', { subject_id: 'x' }, 'policy_rule_subject_iff'],
    ['a narrow subject without an id', { subject_kind: 'role' }, 'policy_rule_subject_iff'],
    [
      'a per-USER subject (the axis §5.3 removed)',
      { subject_kind: 'user', subject_id: 'u1' },
      'policy_rule_subject_kind',
    ],
    ['an unknown role', { subject_kind: 'role', subject_id: 'root' }, 'policy_rule_role'],
    [
      'constraints on a deny',
      { args: '[{"op":"present","ptr":"/x"}]' },
      'policy_rule_no_args_on_deny',
    ],
    ['a regex-looking pattern', { name_pattern: 'write_(file|dir)' }, 'policy_rule_pattern'],
    [
      'an approval effect (not in this phase)',
      { effect: 'require_approval' },
      'policy_rule_effect',
    ],
    [
      'args that are not an array',
      { effect: 'allow', args: '{"op":"present"}' },
      'policy_rule_args_array',
    ],
  ])('rejects %s', async (_n, over, constraint) => {
    await expect(add(over)).rejects.toEqual(violates(constraint));
  });

  it('server_id is required and is a real server', async () => {
    await expect(add({ server_id: null })).rejects.toEqual(
      expect.objectContaining({ code: '23502' }),
    );
    await expect(add({ server_id: '00000000-0000-4000-8000-000000000000' })).rejects.toEqual(
      expect.objectContaining({ code: '23503' }),
    );
  });

  it('note is text of at most 200 characters', async () => {
    await expect(add({ note: 'x'.repeat(201) })).rejects.toEqual(
      expect.objectContaining({ code: '22001' }),
    );
  });
});

describe('seq', () => {
  it('is unique', async () => {
    await add({ seq: 5 });
    await expect(add({ seq: 5 })).rejects.toEqual(expect.objectContaining({ code: '23505' }));
  });

  it('is DEFERRABLE: two rules can swap positions inside one transaction', async () => {
    const a = (await add({ seq: 1 })).rows[0].id;
    const b = (await add({ seq: 2 })).rows[0].id;
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('update policy_rule set seq = 2 where id = $1', [a]);
      await client.query('update policy_rule set seq = 1 where id = $1', [b]);
      await client.query('commit');
    } finally {
      client.release();
    }
    const r = await pool.query('select id from policy_rule where seq in (1, 2) order by seq');
    expect(r.rows.map((x) => x.id)).toEqual([b, a]);
  });
});

describe('audit_event.count', () => {
  it('defaults to 1', async () => {
    await pool.query(`insert into audit_event (evt) values ('policy.deny')`);
    const r = await pool.query(`select count from audit_event where evt = 'policy.deny'`);
    expect(r.rows[0].count).toBe(1);
  });
});

describe('rules go with their server', () => {
  it('cascade on delete', async () => {
    const s = await pool.query(
      `insert into servers (slug, config) values ('tmp', '{"type":"stdio","command":"x"}') returning id`,
    );
    await add({ server_id: s.rows[0].id });
    await pool.query('delete from servers where id = $1', [s.rows[0].id]);
    const left = await pool.query('select 1 from policy_rule where server_id = $1', [s.rows[0].id]);
    expect(left.rowCount).toBe(0);
  });
});
