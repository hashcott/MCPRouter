import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { open, seal, type Keyring, type SealedSecret, type SecretScope } from '../security/seal.js';
import type { ServerConfig } from '../types.js';
import type { Db } from './client.js';
import { secrets, servers } from './schema/index.js';
import {
  PlainServerConfig,
  StoredServerConfig,
  type PlainServerConfigInput,
} from './server-config.js';

export type NewServer = {
  slug: string;
  config: PlainServerConfigInput;
  enabled?: boolean;
  credentialMode?: 'shared' | 'per-user';
  allowPrivateNetwork?: boolean;
};

export type LoadedServers = {
  configs: ServerConfig[];
  errors: { slug: string; reason: string }[];
};

type Ref = { $secret: string };

/**
 * Seals every env/header value into `secrets` and stores only refs in
 * `servers.config`, in one transaction: a server without its secrets, or
 * secrets without their server, never exist.
 */
export async function createServer(db: Db, kr: Keyring, input: NewServer): Promise<string> {
  const plain = PlainServerConfig.parse(input.config);
  const serverId = randomUUID();
  const sealed: SealedSecret[] = [];
  const toRefs = (values: Record<string, string>, scope: SecretScope): Record<string, Ref> =>
    Object.fromEntries(
      Object.entries(values).map(([label, value]) => {
        const s = seal(kr, { id: randomUUID(), scope, serverId, userId: null, label }, value);
        sealed.push(s);
        return [label, { $secret: s.id }];
      }),
    );
  const config: StoredServerConfig =
    plain.type === 'stdio'
      ? { ...plain, env: toRefs(plain.env, 'server_env') }
      : { ...plain, headers: toRefs(plain.headers, 'server_header') };

  await db.transaction(async (tx) => {
    await tx.insert(servers).values({
      id: serverId,
      slug: input.slug,
      config,
      enabled: input.enabled ?? true,
      credentialMode: input.credentialMode ?? 'shared',
      allowPrivateNetwork: input.allowPrivateNetwork ?? false,
    });
    if (sealed.length > 0) await tx.insert(secrets).values(sealed);
  });
  return serverId;
}

/**
 * Every server row with its secrets opened, in the Engine's shape. A row that
 * cannot be parsed or opened lands in `errors` and is left out: one bad row
 * must neither take down every other upstream nor disappear silently (§11.7).
 */
export async function loadServerConfigs(db: Db, kr: Keyring): Promise<LoadedServers> {
  const rows = await db.select().from(servers).orderBy(servers.slug);
  const secretRows =
    rows.length === 0
      ? []
      : await db
          .select()
          .from(secrets)
          .where(
            inArray(
              secrets.serverId,
              rows.map((r) => r.id),
            ),
          );

  const out: LoadedServers = { configs: [], errors: [] };
  for (const row of rows) {
    try {
      // Open with the identity THIS row expects, not the one stored beside the
      // ciphertext: a ref or ciphertext moved from another server, label or
      // scope then fails authentication instead of decrypting.
      const resolve = (values: Record<string, Ref>, scope: SecretScope): Record<string, string> =>
        Object.fromEntries(
          Object.entries(values).map(([label, ref]) => {
            const s = secretRows.find((x) => x.id === ref.$secret && x.serverId === row.id);
            if (s === undefined) throw new Error(`secret ${ref.$secret} for ${label} is missing`);
            return [label, open(kr, { ...s, scope, serverId: row.id, userId: null, label })];
          }),
        );
      const cfg = StoredServerConfig.parse(row.config);
      const base = { name: row.slug, enabled: row.enabled, credentialMode: row.credentialMode };
      out.configs.push(
        cfg.type === 'stdio'
          ? {
              ...base,
              type: 'stdio',
              command: cfg.command,
              args: cfg.args,
              env: resolve(cfg.env, 'server_env'),
              cwd: cfg.cwd,
            }
          : {
              ...base,
              type: cfg.type,
              url: cfg.url,
              headers: resolve(cfg.headers, 'server_header'),
              allowPrivateNetwork: row.allowPrivateNetwork,
            },
      );
    } catch (err) {
      out.errors.push({ slug: row.slug, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
