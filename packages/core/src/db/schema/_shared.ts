import { sql } from 'drizzle-orm';
import { timestamp } from 'drizzle-orm/pg-core';

export const createdAt = timestamp('created_at', { withTimezone: true })
  .notNull()
  .default(sql`now()`);

export const updatedAt = timestamp('updated_at', { withTimezone: true })
  .notNull()
  .default(sql`now()`);
