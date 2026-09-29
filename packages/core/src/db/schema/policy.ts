import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { timestamps } from './_shared.js';
import { servers } from './servers.js';

/**
 * Guardrail rules (§11.3): rows in a table, not a language. First match on `seq`.
 * Policy is default-allow and purely subtractive — grants are the authorization layer.
 *
 * `seq` is UNIQUE and DEFERRABLE INITIALLY DEFERRED (the constraint is re-created that
 * way by a hand-written migration, drizzle cannot express deferrability): a reorder
 * rewrites every seq in one transaction without colliding mid-way.
 */
export const policyRule = pgTable(
  'policy_rule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: integer('seq').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** any | role | api_key. There is NO `user` subject: that is the per-user axis §5.3 removed. */
    subjectKind: text('subject_kind').$type<'any' | 'role' | 'api_key'>().notNull().default('any'),
    /** role name, or the better-auth apikey id. NULL iff subject_kind = 'any'. */
    subjectId: text('subject_id'),
    /**
     * An FK, never a slug: renaming a server must not silently turn every deny into a
     * no-op (§11.3). The slug is rendered from the join.
     */
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    itemKind: text('item_kind').$type<'tool' | 'prompt' | 'resource'>().notNull().default('tool'),
    /** BARE upstream name; `*` is the only metacharacter. */
    namePattern: text('name_pattern').notNull().default('*'),
    effect: text('effect').$type<'allow' | 'deny'>().notNull(),
    /** Argument constraints, ANDed, allow rules only. Validated by zod at every write and read. */
    args: jsonb('args')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Shown to the CALLER on a deny: the one thing policy tells the client (§11.1). Text only. */
    note: varchar('note', { length: 200 }),
    /** Break-glass denies must switch themselves off. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('policy_rule_seq_uq').on(t.seq),
    check('policy_rule_subject_kind', sql`${t.subjectKind} in ('any', 'role', 'api_key')`),
    check('policy_rule_subject_iff', sql`(${t.subjectKind} = 'any') = (${t.subjectId} is null)`),
    check(
      'policy_rule_role',
      sql`${t.subjectKind} <> 'role' or ${t.subjectId} in ('viewer', 'operator', 'admin')`,
    ),
    check('policy_rule_item_kind', sql`${t.itemKind} in ('tool', 'prompt', 'resource')`),
    check('policy_rule_effect', sql`${t.effect} in ('allow', 'deny')`),
    check('policy_rule_pattern', sql`${t.namePattern} ~ '^[A-Za-z0-9_*.:/-]{1,128}$'`),
    check('policy_rule_args_array', sql`jsonb_typeof(${t.args}) = 'array'`),
    check(
      'policy_rule_no_args_on_deny',
      sql`${t.effect} <> 'deny' or jsonb_array_length(${t.args}) = 0`,
    ),
  ],
);

export type PolicyRuleRow = typeof policyRule.$inferSelect;
