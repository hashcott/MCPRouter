import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Logger } from 'pino';
import type pg from 'pg';
import { createDb } from './client.js';

export { createPool, createDb, type Db } from './client.js';

/**
 * Stable 32-bit key for pg_advisory_lock. Any constant works as long as it
 * never changes; changing it would let two versions migrate concurrently.
 */
export const MIGRATION_LOCK_ID = 0x6d_63_70_72; // "mcpr"

function migrationsFolder(): string {
  // packages/core/dist/db/migrate.js -> repo root -> drizzle
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../../drizzle');
}

export async function runMigrations(pool: pg.Pool, log: Logger): Promise<void> {
  const client = await pool.connect();
  try {
    log.info({ evt: 'db.migrate.lock' }, 'acquiring migration lock');
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      const db = createDb(pool);
      await migrate(db, { migrationsFolder: migrationsFolder() });
      log.info({ evt: 'db.migrate.done' }, 'migrations applied');
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}
