import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export type Outcome = 'ok' | 'error' | 'denied' | 'not_found' | 'timeout';

/**
 * The ONLY audit log (§6). No partition and NO foreign key, names denormalized:
 * revoking a key or deleting a server can neither erase nor blank the trail.
 */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    evt: text('evt').notNull(),
    requestId: text('request_id'),
    principalId: text('principal_id'),
    keyId: text('key_id'),
    /** 'all' | 'g/<group>' | 's/<server>' */
    route: text('route'),
    server: text('server'),
    item: text('item'),
    outcome: text('outcome').$type<Outcome>(),
    durationMs: integer('duration_ms'),
    /** metadata mode: argument KEY NAMES only, never values (§8). */
    inputKeys: text('input_keys').array(),
    inputBytes: integer('input_bytes'),
    error: text('error'),
  },
  (t) => [
    index('audit_event_at_idx').on(t.at),
    check(
      'audit_event_outcome',
      sql`${t.outcome} is null or ${t.outcome} in ('ok', 'error', 'denied', 'not_found', 'timeout')`,
    ),
  ],
);
