import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './_shared.js';
import { auditEvent } from './audit.js';
import * as auth from './auth.js';
import { groupServer, groups, serverItemOverride } from './groups.js';
import { secrets } from './secrets.js';
import { servers } from './servers.js';

export * from './auth.js';
export { auditEvent, groupServer, groups, secrets, servers, serverItemOverride };
export type { Outcome } from './audit.js';
export type { Selection } from './groups.js';

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

export const schema = {
  systemSetting,
  servers,
  secrets,
  groups,
  groupServer,
  serverItemOverride,
  auditEvent,
  ...auth,
};
export type Schema = typeof schema;
