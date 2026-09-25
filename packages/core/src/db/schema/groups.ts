import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { timestamps } from './_shared.js';
import { servers } from './servers.js';

/** BARE upstream item names, or every item. */
export type Selection = 'all' | string[];

const SLUG = `'^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'`;
const selectionOk = (col: unknown) =>
  sql`(${col} = '"all"'::jsonb or jsonb_typeof(${col}) = 'array')`;

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('groups_slug_uq').on(t.slug),
    check('groups_slug_fmt', sql`${t.slug} ~ ${sql.raw(SLUG)}`),
  ],
);

/** Membership + item selection + alias in one record (§6). */
export const groupServer = pgTable(
  'group_server',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    /** Renames the server on this group's route only. */
    alias: text('alias'),
    tools: jsonb('tools')
      .$type<Selection>()
      .notNull()
      .default(sql`'"all"'::jsonb`),
    prompts: jsonb('prompts')
      .$type<Selection>()
      .notNull()
      .default(sql`'"all"'::jsonb`),
    resources: jsonb('resources')
      .$type<Selection>()
      .notNull()
      .default(sql`'"all"'::jsonb`),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.serverId] }),
    // The cascade probe from servers, and "which groups is this server in".
    index('group_server_server_idx').on(t.serverId),
    // NULLs are distinct, so any number of members may go un-aliased.
    uniqueIndex('group_server_alias_uq').on(t.groupId, t.alias),
    check('group_server_alias_fmt', sql`${t.alias} is null or ${t.alias} ~ ${sql.raw(SLUG)}`),
    check(
      'group_server_selection',
      sql`${selectionOk(t.tools)} and ${selectionOk(t.prompts)} and ${selectionOk(t.resources)}`,
    ),
  ],
);

/** Per-item enable + description override, keyed on the BARE upstream name (§4.1, §6). */
export const serverItemOverride = pgTable(
  'server_item_override',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'tool' | 'prompt' | 'resource'>().notNull(),
    itemName: text('item_name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    description: text('description'),
    /** Operator OPINION (§11.2). NULL = no opinion yet = unreviewed. `changed` is derived, never stored. */
    reviewState: text('review_state').$type<'approved' | 'unreviewed' | 'rejected'>(),
    approvedHash: text('approved_hash'),
    /** What was actually blessed — the P3 diff pane and every post-incident question need it. */
    approvedDef: jsonb('approved_def'),
    approvedBy: text('approved_by').references(() => user.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.serverId, t.kind, t.itemName] }),
    check('server_item_override_kind', sql`${t.kind} in ('tool', 'prompt', 'resource')`),
    check(
      'server_item_override_review_state',
      sql`${t.reviewState} is null or ${t.reviewState} in ('approved', 'unreviewed', 'rejected')`,
    ),
    check(
      'server_item_override_approval_complete',
      sql`${t.reviewState} is distinct from 'approved' or (${t.approvedHash} is not null and ${t.approvedDef} is not null and ${t.approvedAt} is not null)`,
    ),
  ],
);
