import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import type { Pool } from 'pg';
import { parseKeyring } from '../security/seal.js';
import { createDb, createPool, runMigrations, type Db } from './migrate.js';
import { createServer, loadServerConfigs } from './store.js';

const k = (byte: number) => Buffer.alloc(32, byte).toString('base64url');
const KR1 = parseKeyring(`v1:${k(1)}`);
const KR21 = parseKeyring(`v2:${k(2)},v1:${k(1)}`);
const KR2 = parseKeyring(`v2:${k(2)}`);

let pg: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = createPool(pg.getConnectionUri());
  await runMigrations(pool, pino({ level: 'silent' }));
  db = createDb(pool);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
});

beforeEach(async () => {
  await pool.query('delete from servers');
});

const fs = () =>
  createServer(db, KR1, {
    slug: 'fs',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'fs-mcp'],
      env: { API_KEY: 'sk-live-123' },
    },
  });
const remote = () =>
  createServer(db, KR1, {
    slug: 'remote',
    allowPrivateNetwork: true,
    config: {
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer tok-9' },
    },
  });

describe('createServer + loadServerConfigs', () => {
  it('round-trips into the Engine shape', async () => {
    await fs();
    await remote();
    const r = await loadServerConfigs(db, KR1);
    expect(r.errors).toEqual([]);
    expect(r.configs).toEqual([
      {
        name: 'fs',
        enabled: true,
        credentialMode: 'shared',
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'fs-mcp'],
        env: { API_KEY: 'sk-live-123' },
        cwd: undefined,
      },
      {
        name: 'remote',
        enabled: true,
        credentialMode: 'shared',
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer tok-9' },
        allowPrivateNetwork: true,
      },
    ]);
  });

  it('leaves no plaintext anywhere in the database', async () => {
    await fs();
    await remote();
    const dump = await pool.query(
      `select coalesce(string_agg(t::text, ''), '') as s from (
         select row_to_json(s)::text as t from servers s
         union all select row_to_json(x)::text from secrets x) q`,
    );
    const s: string = dump.rows[0].s;
    expect(s).toContain('$secret');
    expect(s).not.toContain('sk-live-123');
    expect(s).not.toContain('tok-9');
  });

  it('a server with no env stores no secrets and still loads', async () => {
    await createServer(db, KR1, { slug: 'bare', config: { type: 'stdio', command: 'x' } });
    const n = await pool.query('select count(*)::int as n from secrets');
    expect(n.rows[0].n).toBe(0);
    expect((await loadServerConfigs(db, KR1)).configs).toHaveLength(1);
  });

  it('rejects plaintext it cannot validate before touching the DB', async () => {
    await expect(
      createServer(db, KR1, {
        slug: 'bad',
        config: { type: 'stdio', command: 'x', env: { K: '' } },
      }),
    ).rejects.toThrow();
    const n = await pool.query('select count(*)::int as n from servers');
    expect(n.rows[0].n).toBe(0);
  });

  it('a secrets insert that fails rolls the server row back too', async () => {
    // Over the 64 KiB secrets_ct_len CHECK: the servers insert succeeds, the secrets insert fails.
    await expect(
      createServer(db, KR1, {
        slug: 'huge',
        config: { type: 'stdio', command: 'x', env: { K: 'x'.repeat(70_000) } },
      }),
    ).rejects.toThrow();
    const n = await pool.query('select count(*)::int as n from servers');
    expect(n.rows[0].n).toBe(0);
  });

  it('duplicate slug: the insert fails and no orphan secrets survive', async () => {
    await fs();
    await expect(fs()).rejects.toThrow();
    const n = await pool.query('select count(*)::int as n from secrets');
    expect(n.rows[0].n).toBe(1);
  });
});

describe('a server whose secrets cannot be opened', () => {
  it('ciphertext copied from another server: reported, and the other server still loads', async () => {
    await fs();
    await remote();
    await pool.query(
      `update secrets set (iv, ciphertext, tag) =
         (select iv, ciphertext, tag from secrets where label = 'Authorization')
       where label = 'API_KEY'`,
    );
    const r = await loadServerConfigs(db, KR1);
    expect(r.configs.map((c) => c.name)).toEqual(['remote']);
    expect(r.errors).toEqual([
      { slug: 'fs', reason: expect.stringMatching(/cannot be opened: auth-failed/) },
    ]);
  });

  it('ref moved to another server: missing, never decrypted', async () => {
    await fs();
    await remote();
    await pool.query(
      `update servers set config = jsonb_set(config, '{env,API_KEY}',
         (select config->'headers'->'Authorization' from servers where slug = 'remote'))
       where slug = 'fs'`,
    );
    const r = await loadServerConfigs(db, KR1);
    expect(r.errors).toEqual([{ slug: 'fs', reason: expect.stringMatching(/is missing/) }]);
    // fs is left out entirely; only remote, the secret's real owner, holds the value.
    expect(r.configs.map((c) => c.name)).toEqual(['remote']);
  });

  it('env key renamed in the config: the label is in the AAD, so it fails', async () => {
    await fs();
    await pool.query(
      `update servers set config = jsonb_set(config - 'env', '{env}',
         jsonb_build_object('OTHER', config->'env'->'API_KEY')) where slug = 'fs'`,
    );
    const r = await loadServerConfigs(db, KR1);
    expect(r.errors).toEqual([{ slug: 'fs', reason: expect.stringMatching(/auth-failed/) }]);
  });

  it('a config that no longer parses is reported, not thrown', async () => {
    await fs();
    await pool.query(`update servers set config = config || '{"shell": true}' where slug = 'fs'`);
    const r = await loadServerConfigs(db, KR1);
    expect(r.configs).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });
});

describe('rotation', () => {
  it('rows sealed under v1 open with v2,v1; new rows seal under v2; v2 alone reports unknown-key', async () => {
    await fs();
    expect((await loadServerConfigs(db, KR21)).errors).toEqual([]);

    await createServer(db, KR21, {
      slug: 'new',
      config: { type: 'stdio', command: 'x', env: { K: 'v' } },
    });
    const kv = await pool.query(`select key_version from secrets where label = 'K'`);
    expect(kv.rows[0].key_version).toBe(2);

    const r = await loadServerConfigs(db, KR2);
    expect(r.configs.map((c) => c.name)).toEqual(['new']);
    expect(r.errors).toEqual([{ slug: 'fs', reason: expect.stringMatching(/unknown-key/) }]);
  });
});

describe('§11.7 — a new column on secrets does not change the AAD', () => {
  it('seal, add a column, open again', async () => {
    await fs();
    await pool.query('alter table secrets add column scan_egress boolean not null default false');
    try {
      const r = await loadServerConfigs(db, KR1);
      expect(r.errors).toEqual([]);
      expect(r.configs[0]).toMatchObject({ env: { API_KEY: 'sk-live-123' } });
    } finally {
      await pool.query('alter table secrets drop column scan_egress');
    }
  });
});
