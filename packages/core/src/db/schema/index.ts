import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './_shared.js';

/**
 * Single-row-per-key system configuration. In P0 it exists to give the
 * migration chain something real to create and to hold the first-admin
 * bootstrap token later (spec §6).
 */
export const systemSetting = pgTable('system_setting', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  createdAt,
  updatedAt,
});

export const schema = { systemSetting };
export type Schema = typeof schema;
