import { asc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type pg from 'pg';
import { z } from 'zod';
import {
  loadServerConfigs,
  schema,
  type Db,
  type Engine,
  type Keyring,
  type Selection,
} from '@mcprouter/core';
import { EMPTY_SNAPSHOT, reusedSlugs, type Member, type Snapshot } from './scope.js';

export type ServerSync = {
  /** What the last successful poll applied. */
  snapshot(): Snapshot;
  refresh(): Promise<void>;
  stop(): void;
};

const SelectionSchema = z.union([z.literal('all'), z.array(z.string())]);
/** Fail closed: a selection that does not parse exposes nothing. */
const selection = (raw: unknown): Selection => {
  const r = SelectionSchema.safeParse(raw);
  return r.success ? r.data : [];
};

/**
 * Keeps the Engine and the routing snapshot in step with the database.
 * ponytail: polls an md5 of every row of the tables that shape routing
 * every `intervalMs` — no long-lived LISTEN connection to re-establish,
 * correct across replicas, O(rows) per poll. Switch to LISTEN/NOTIFY if 5 s of
 * staleness or thousands of servers ever matter.
 */
export async function startServerSync(o: {
  pool: pg.Pool;
  db: Db;
  keyring: Keyring;
  engine: Engine;
  log: Logger;
  intervalMs?: number;
}): Promise<ServerSync> {
  let fingerprint: string | undefined;
  let snap: Snapshot = EMPTY_SNAPSHOT;
  let queue = Promise.resolve();

  const tick = async (): Promise<void> => {
    // Whole rows: an edit made in psql, or a re-sealed secret, is seen without
    // any writer having to remember to bump updated_at.
    const r = await o.pool.query<{ v: string }>(
      `select md5(
         coalesce((select string_agg(s::text, ',' order by s.id) from servers s), '') ||
         coalesce((select string_agg(x::text, ',' order by x.id) from secrets x
                   where x.server_id is not null), '') ||
         coalesce((select string_agg(g::text, ',' order by g.id) from groups g), '') ||
         coalesce((select string_agg(m::text, ',' order by m.group_id, m.server_id)
                   from group_server m), '') ||
         coalesce((select string_agg(o::text, ',' order by o.server_id, o.kind, o.item_name)
                   from server_item_override o), '')
       ) as v`,
    );
    const v = r.rows[0]?.v ?? '';
    if (v === fingerprint) return;

    // One consistent read (a single REPEATABLE READ snapshot) BEFORE the Engine is
    // touched: configs, servers and memberships all describe the same moment, and no
    // query can fail after applyConfig and leave the old snapshot routing to new servers.
    const read = await o.db.transaction(
      async (tx) => {
        const loadedServers = await loadServerConfigs(tx, o.keyring);
        const serverRows = await tx
          .select({ id: schema.servers.id, slug: schema.servers.slug })
          .from(schema.servers)
          .orderBy(asc(schema.servers.slug));
        const memberRows = await tx
          .select({
            groupId: schema.groups.id,
            groupSlug: schema.groups.slug,
            serverId: schema.groupServer.serverId,
            serverSlug: schema.servers.slug,
            alias: schema.groupServer.alias,
            tools: schema.groupServer.tools,
            prompts: schema.groupServer.prompts,
            resources: schema.groupServer.resources,
          })
          .from(schema.groups)
          .leftJoin(schema.groupServer, eq(schema.groupServer.groupId, schema.groups.id))
          .leftJoin(schema.servers, eq(schema.servers.id, schema.groupServer.serverId))
          .orderBy(asc(schema.groups.slug), asc(schema.servers.slug));
        return { ...loadedServers, serverRows, memberRows };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    const { configs, errors, serverRows, memberRows } = read;
    for (const e of errors) {
      o.log.error(
        { evt: 'servers.load_failed', server: e.slug, reason: e.reason },
        'server left out',
      );
    }

    const loaded = new Map(configs.map((c) => [c.name, c.enabled]));
    const groups = new Map<string, { id: string; members: Member[] }>();
    for (const m of memberRows) {
      const g = groups.get(m.groupSlug) ?? { id: m.groupId, members: [] };
      groups.set(m.groupSlug, g);
      if (m.serverId === null || m.serverSlug === null) continue; // a group with no members
      g.members.push({
        serverId: m.serverId,
        serverSlug: m.serverSlug,
        ...(m.alias === null ? {} : { alias: m.alias }),
        tools: selection(m.tools),
        prompts: selection(m.prompts),
        resources: selection(m.resources),
      });
    }
    const next: Snapshot = {
      // Only servers the Engine holds; one whose secrets failed to open is not routable.
      servers: serverRows
        .filter((s) => loaded.has(s.slug))
        .map((s) => ({ id: s.id, slug: s.slug, enabled: loaded.get(s.slug) === true })),
      groups,
    };

    // A slug deleted and re-created: the old snapshot would route to the new upstream
    // while the Engine swaps. Serve nothing for that (rare) moment rather than the wrong thing.
    if (reusedSlugs(snap, next).size > 0) snap = EMPTY_SNAPSHOT;
    await o.engine.applyConfig(configs);
    snap = next;
    fingerprint = v;
    o.log.info(
      { evt: 'servers.applied', count: configs.length, failed: errors.length },
      'servers applied',
    );
  };

  // Serialized: a slow load can never be overtaken by a newer one and applied after it.
  const refresh = (): Promise<void> => {
    queue = queue
      .then(tick)
      .catch((err: unknown) =>
        o.log.error({ evt: 'servers.sync_failed', err }, 'server sync failed'),
      );
    return queue;
  };

  await refresh();
  const timer = setInterval(() => void refresh(), o.intervalMs ?? 5_000);
  timer.unref();
  return { snapshot: () => snap, refresh, stop: () => clearInterval(timer) };
}
