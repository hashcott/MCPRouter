import type { Logger } from 'pino';
import type pg from 'pg';
import {
  loadServerConfigs,
  type Db,
  type Engine,
  type Keyring,
  type ResolvedScope,
} from '@mcprouter/core';

export type ServerSync = {
  /** The `{kind:'all'}` target: every enabled server of the last applied table. */
  scopeAll(): ResolvedScope;
  refresh(): Promise<void>;
  stop(): void;
};

export const EMPTY_SCOPE: ResolvedScope = { key: 'all:', servers: [], flatten: false };

/**
 * Keeps the Engine in step with the `servers` table.
 * ponytail: polls a fingerprint of (id, updated_at) every `intervalMs` — no
 * long-lived LISTEN connection to re-establish, correct across replicas.
 * Switch to LISTEN/NOTIFY if 5 s of staleness ever matters. Every writer to
 * `servers` must bump `updated_at` (createServer inserts; later editors update it).
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
  let scope = EMPTY_SCOPE;
  let queue = Promise.resolve();

  const tick = async (): Promise<void> => {
    const r = await o.pool.query<{ v: string }>(
      `select md5(coalesce(string_agg(id::text || updated_at::text, ',' order by id), '')) as v
       from servers`,
    );
    const v = r.rows[0]?.v ?? '';
    if (v === fingerprint) return;

    const { configs, errors } = await loadServerConfigs(o.db, o.keyring);
    for (const e of errors) {
      o.log.error(
        { evt: 'servers.load_failed', server: e.slug, reason: e.reason },
        'server left out',
      );
    }
    await o.engine.applyConfig(configs);
    const names = configs.filter((c) => c.enabled).map((c) => c.name);
    scope = {
      key: `all:${names.join(',')}`,
      servers: names.map((serverName) => ({
        serverName,
        tools: 'all',
        prompts: 'all',
        resources: 'all',
      })),
      flatten: false,
    };
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
  return { scopeAll: () => scope, refresh, stop: () => clearInterval(timer) };
}
