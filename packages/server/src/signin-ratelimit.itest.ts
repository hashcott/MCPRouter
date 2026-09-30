import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import { createDb, createPool, runMigrations } from '@mcprouter/core';
import { createAuth, passwordHasher } from './auth.js';
import * as ops from './console/ops.js';

let pg: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createPool>;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = createPool(pg.getConnectionUri());
  await runMigrations(pool, pino({ level: 'silent' }));
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
});

const attempt = (auth: ReturnType<typeof createAuth>, xff: string) =>
  auth.handler(
    new Request('http://hub.test/api/auth/sign-in/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://hub.test',
        'x-forwarded-for': xff,
      },
      body: JSON.stringify({ email: 'a@x.io', password: 'wrong wrong wrong' }),
    }),
  );

describe('sign-in rate limiting', () => {
  it('is on outside production, and a forged X-Forwarded-For buys no extra guesses', async () => {
    const auth = createAuth({
      db: createDb(pool),
      secret: 's'.repeat(32),
      baseURL: 'http://hub.test',
      log: pino({ level: 'silent' }),
    });
    await ops.addUser(
      pool,
      { email: 'a@x.io', name: 'A', role: 'viewer', password: 'the real password' },
      passwordHasher(auth),
    );
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await attempt(auth, `10.0.0.${i}`)).status);
    expect(statuses).toContain(429);
  });

  it('with a trusted proxy configured, each real client IP gets its own bucket', async () => {
    const auth = createAuth({
      db: createDb(pool),
      secret: 's'.repeat(32),
      baseURL: 'http://hub.test',
      log: pino({ level: 'silent' }),
      trustedProxies: ['192.0.2.1'],
    });
    const statuses: number[] = [];
    // Six different clients behind the one trusted proxy: nobody is limited.
    for (let i = 0; i < 6; i += 1)
      statuses.push((await attempt(auth, `198.51.100.${i}, 192.0.2.1`)).status);
    expect(statuses).not.toContain(429);
  });
});
