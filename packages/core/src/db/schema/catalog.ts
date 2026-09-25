import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

/**
 * The engine's TRUTH about every item it has seen (§11.2, §11.7). P5 adds the
 * search columns (input_schema, token_cost, tsvector, vector) — R1.
 */
export const toolEmbedding = pgTable(
  'tool_embedding',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'tool' | 'prompt' | 'resource'>().notNull(),
    /** Bare upstream name; the URI for a resource. */
    name: text('name').notNull(),
    /** The definition exactly as received — what an operator sees and approves (R2). */
    def: jsonb('def').notNull(),
    defHash: text('def_hash'),
    shapeHash: text('shape_hash'),
    defect: text('defect'),
    defSeenAt: timestamp('def_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.serverId, t.kind, t.name] }),
    check('tool_embedding_kind', sql`${t.kind} in ('tool', 'prompt', 'resource')`),
    check(
      'tool_embedding_hash_xor_defect',
      sql`(${t.defHash} is not null and ${t.shapeHash} is not null and ${t.defect} is null)
        or (${t.defHash} is null and ${t.shapeHash} is null and ${t.defect} is not null)`,
    ),
  ],
);
