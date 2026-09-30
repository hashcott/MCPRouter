import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type pg from 'pg';

const KEY = 'bootstrap_admin';
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * §6: no seeded credentials, ever (mcphub ships admin/admin123). On a fresh install
 * — zero users — every boot writes a fresh 256-bit token's HASH and prints the token
 * once to the boot log. Once anyone exists, the row is removed.
 *
 * ponytail: with several replicas booting an unclaimed install, the newest boot's
 * token is the valid one (each boot replaces the hash). Claim from that log line.
 */
export async function ensureBootstrap(pool: pg.Pool, log: Logger): Promise<void> {
  const users = await pool.query<{ n: number }>('select count(*)::int as n from "user"');
  if ((users.rows[0]?.n ?? 0) > 0) {
    await pool.query('delete from system_setting where key = $1', [KEY]);
    return;
  }
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `insert into system_setting (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [KEY, JSON.stringify({ hash: sha(token) })],
  );
  log.warn(
    { evt: 'bootstrap.token' },
    `No users yet. Claim the first admin: POST /api/bootstrap {"token":"${token}", email, name, password}`,
  );
}

/**
 * The claim. `DELETE … RETURNING` on the token row IS the mutex (§6): two concurrent
 * claims cannot both see the row. The admin is created in the SAME transaction, so a
 * failed claim leaves the token in place instead of consuming it for nothing.
 */
export async function claimBootstrap(
  pool: pg.Pool,
  input: { token: string; email: string; name: string; passwordHash: string },
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const claimed = await client.query(
      `delete from system_setting where key = $1 and value->>'hash' = $2 returning key`,
      [KEY, sha(input.token)],
    );
    if (claimed.rowCount !== 1) {
      await client.query('rollback');
      return null;
    }
    const id = randomUUID();
    await client.query(
      `insert into "user" (id, name, email, role, email_verified) values ($1, $2, $3, 'admin', true)`,
      [id, input.name, input.email],
    );
    await client.query(
      `insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values ($1, $2, 'credential', $2, $3, now(), now())`,
      [randomUUID(), id, input.passwordHash],
    );
    await client.query('commit');
    return id;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
