import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { schema, type Schema } from './schema/index.js';

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

export function createDb(pool: pg.Pool): NodePgDatabase<Schema> {
  return drizzle(pool, { schema });
}

export type Db = NodePgDatabase<Schema>;
