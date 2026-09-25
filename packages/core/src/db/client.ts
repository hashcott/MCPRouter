import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema, type Schema } from './schema/index.js';

export function createPool(databaseUrl: string): Pool {
  // A dead database must fail fast, not hang callers (audit flush, shutdown) forever.
  return new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5_000 });
}

export function createDb(pool: Pool): NodePgDatabase<Schema> {
  return drizzle(pool, { schema });
}

export type Db = NodePgDatabase<Schema>;
