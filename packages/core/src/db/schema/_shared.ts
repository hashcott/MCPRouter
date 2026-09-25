import { sql } from 'drizzle-orm';
import { customType, timestamp } from 'drizzle-orm/pg-core';

export const createdAt = timestamp('created_at', { withTimezone: true })
  .notNull()
  .default(sql`now()`);

export const updatedAt = timestamp('updated_at', { withTimezone: true })
  .notNull()
  .default(sql`now()`);

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** Fresh builders per table: a column builder instance must never be shared between tables. */
export const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
