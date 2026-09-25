import { sql } from 'drizzle-orm';
import { boolean, check, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { StoredServerConfig } from '../server-config.js';
import { timestamps } from './_shared.js';

export const servers = pgTable(
  'servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Route segment, namespace prefix, and the Engine's server name. */
    slug: text('slug').notNull(),
    config: jsonb('config').$type<StoredServerConfig>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    credentialMode: text('credential_mode')
      .$type<'shared' | 'per-user'>()
      .notNull()
      .default('shared'),
    allowPrivateNetwork: boolean('allow_private_network').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('servers_slug_uq').on(t.slug),
    check('servers_slug_fmt', sql`${t.slug} ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'`),
    check('servers_credential_mode', sql`${t.credentialMode} in ('shared', 'per-user')`),
    // §5.4: a plaintext env/header value is unstorable, not merely unlikely.
    // env/headers are absent or objects, and every value is exactly
    // {"$secret": "<uuid>"} — no other key, no other type.
    check(
      'servers_no_inline_secret',
      sql`coalesce(jsonb_typeof(${t.config}->'env'), 'object') = 'object'
        and coalesce(jsonb_typeof(${t.config}->'headers'), 'object') = 'object'
        and not jsonb_path_exists(${t.config}, '$.env.* ? (@.type() != "object" || exists(@.keyvalue() ? (@.key != "$secret")) || !exists(@."$secret") || @."$secret".type() != "string" || !(@."$secret" like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))')
        and not jsonb_path_exists(${t.config}, '$.headers.* ? (@.type() != "object" || exists(@.keyvalue() ? (@.key != "$secret")) || !exists(@."$secret") || @."$secret".type() != "string" || !(@."$secret" like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))')`,
    ),
  ],
);
