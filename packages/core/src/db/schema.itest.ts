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

async function insertServer(slug: string, config: unknown): Promise<string> {
  const id = randomUUID();
  await pool.query('insert into servers (id, slug, config) values ($1, $2, $3)', [
    id,
    slug,
    config,
  ]);
  return id;
}

function insertSecret(
  serverId: string,
  over: { iv?: Buffer; tag?: Buffer; ct?: Buffer; scope?: string } = {},
) {
  return pool.query(
    `insert into secrets (id, scope, server_id, label, key_version, iv, ciphertext, tag)
     values ($1, $2, $3, 'K', 1, $4, $5, $6)`,
    [
      randomUUID(),
      over.scope ?? 'server_env',
      serverId,
      over.iv ?? Buffer.alloc(12),
      over.ct ?? Buffer.alloc(8),
      over.tag ?? Buffer.alloc(16),
    ],
  );
}

const violates = (constraint: string) => expect.objectContaining({ code: '23514', constraint });

describe('servers', () => {
  it('stores a config whose env values are refs', async () => {
    await insertServer('refs-ok', {
      type: 'stdio',
      command: 'x',
      env: { K: { $secret: randomUUID() } },
    });
  });

  it('cannot store a plaintext env or header value', async () => {
    await expect(
      insertServer('plain-env', { type: 'stdio', command: 'x', env: { K: 'sk-live' } }),
    ).rejects.toEqual(violates('servers_no_inline_secret'));
    await expect(
      insertServer('plain-hdr', {
        type: 'sse',
        url: 'https://a.example',
        headers: { A: 'Bearer t' },
      }),
    ).rejects.toEqual(violates('servers_no_inline_secret'));
  });

  it.each(['a__b', 'Upper', '-lead', 'a_b'])('rejects slug %j', async (slug) => {
    await expect(insertServer(slug, { type: 'stdio', command: 'x' })).rejects.toEqual(
      violates('servers_slug_fmt'),
    );
  });

  it('rejects a credential_mode outside the set', async () => {
    await expect(
      pool.query(
        `insert into servers (slug, config, credential_mode) values ('cm', '{"type":"stdio"}', 'per_user')`,
      ),
    ).rejects.toEqual(violates('servers_credential_mode'));
  });
});

describe('secrets', () => {
  it('accepts a well-formed row', async () => {
    await insertSecret(await insertServer('sec-ok', { type: 'stdio', command: 'x' }));
  });

  it.each([
    ['11-byte iv', { iv: Buffer.alloc(11) }, 'secrets_iv_len'],
    ['truncated tag', { tag: Buffer.alloc(15) }, 'secrets_tag_len'],
    ['empty ciphertext', { ct: Buffer.alloc(0) }, 'secrets_ct_len'],
    ['unknown scope', { scope: 'nope' }, 'secrets_scope'],
  ])('rejects a %s', async (_n, over, constraint) => {
    const id = await insertServer(`sec-${constraint.replaceAll('_', '-')}`, {
      type: 'stdio',
      command: 'x',
    });
    await expect(insertSecret(id, over)).rejects.toEqual(violates(constraint));
  });

  it('goes away with its server', async () => {
    const id = await insertServer('cascade', { type: 'stdio', command: 'x' });
    await insertSecret(id);
    await pool.query('delete from servers where id = $1', [id]);
    const left = await pool.query('select 1 from secrets where server_id = $1', [id]);
    expect(left.rowCount).toBe(0);
  });
});
