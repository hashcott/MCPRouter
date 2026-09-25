import { sql } from 'drizzle-orm';
import { check, index, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { SECRET_SCOPES, type SecretScope } from '../../security/seal.js';
import { bytea, timestamps } from './_shared.js';
import { servers } from './servers.js';

/**
 * The only encrypted store (§5.4). The AAD is the frozen field list in
 * security/seal.ts — adding a column here does NOT change it, and must not.
 */
export const secrets = pgTable(
  'secrets',
  {
    // No default: the id is sealed into the AAD, so the writer mints it before sealing.
    id: uuid('id').primaryKey(),
    scope: text('scope').$type<SecretScope>().notNull(),
    serverId: uuid('server_id').references(() => servers.id, { onDelete: 'cascade' }),
    // FK to better-auth's "user" arrives with that table in P1c.
    userId: text('user_id'),
    /** Env var name, header name, 'access_token', … */
    label: text('label').notNull(),
    keyVersion: smallint('key_version').notNull(),
    iv: bytea('iv').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    tag: bytea('tag').notNull(),
    ...timestamps(),
  },
  (t) => [
    check(
      'secrets_scope',
      sql`${t.scope} in (${sql.raw(SECRET_SCOPES.map((s) => `'${s}'`).join(', '))})`,
    ),
    check('secrets_iv_len', sql`octet_length(${t.iv}) = 12`),
    check('secrets_tag_len', sql`octet_length(${t.tag}) = 16`),
    check('secrets_ct_len', sql`octet_length(${t.ciphertext}) between 1 and 65536`),
    check('secrets_key_version', sql`${t.keyVersion} > 0`),
    // Makes the ON DELETE CASCADE probe from servers an index scan.
    index('secrets_server_idx').on(t.serverId),
  ],
);
