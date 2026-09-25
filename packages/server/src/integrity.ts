import { and, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { schema, type Db, type Engine, type ItemDef, type ItemKind } from '@mcprouter/core';

const KINDS: ItemKind[] = ['tool', 'prompt', 'resource'];

/**
 * The engine writes TRUTH (tool_embedding) on every catalog it sees; the one
 * automatic OPINION is TOFU, exactly once per server (§11.2):
 *   - an enabled server whose first_enabled_at IS NULL: approve what it lists,
 *     and set first_enabled_at in the SAME transaction;
 *   - otherwise, never-seen names follow `newItems` ('quarantine' writes nothing).
 * Auto-approval only fills rows with no opinion yet (R4). Re-enable approves nothing.
 */
export function startTruthWriter(o: {
  db: Db;
  engine: Engine;
  log: Logger;
  newItems: 'quarantine' | 'approve';
}): { stop(): void; idle(): Promise<void> } {
  let queue = Promise.resolve();

  const record = async (name: string): Promise<void> => {
    const catalog = o.engine.catalog(name);
    if (catalog === undefined) return;
    await o.db.transaction(async (tx) => {
      const [srv] = await tx
        .select({
          id: schema.servers.id,
          enabled: schema.servers.enabled,
          firstEnabledAt: schema.servers.firstEnabledAt,
        })
        .from(schema.servers)
        .where(eq(schema.servers.slug, name))
        .for('update');
      if (srv === undefined) return;

      const items: { kind: ItemKind; name: string; item: ItemDef }[] = KINDS.flatMap((kind) =>
        [...catalog.defs[kind]].map(([n, item]) => ({ kind, name: n, item })),
      );

      for (const { kind, name: n, item } of items) {
        const h = item.hashes === 'defect' ? null : item.hashes;
        await tx
          .insert(schema.toolEmbedding)
          .values({
            serverId: srv.id,
            kind,
            name: n,
            def: item.def,
            defHash: h?.defHash ?? null,
            shapeHash: h?.shapeHash ?? null,
            defect: h === null ? 'too_deep' : null,
          })
          .onConflictDoUpdate({
            target: [
              schema.toolEmbedding.serverId,
              schema.toolEmbedding.kind,
              schema.toolEmbedding.name,
            ],
            set: {
              def: sql`excluded.def`,
              defHash: sql`excluded.def_hash`,
              shapeHash: sql`excluded.shape_hash`,
              defect: sql`excluded.defect`,
              defSeenAt: sql`now()`,
            },
            // Kills churn when an upstream flaps between identical catalogs (§11.7).
            setWhere: sql`${schema.toolEmbedding.defHash} is distinct from excluded.def_hash
                          or ${schema.toolEmbedding.defect} is distinct from excluded.defect`,
          });
      }

      const tofu = srv.enabled && srv.firstEnabledAt === null;
      if (tofu || (srv.enabled && o.newItems === 'approve')) {
        for (const { kind, name: n, item } of items) {
          if (item.hashes === 'defect') continue;
          await tx
            .insert(schema.serverItemOverride)
            .values({
              serverId: srv.id,
              kind,
              itemName: n,
              reviewState: 'approved',
              approvedHash: item.hashes.defHash,
              approvedDef: item.def,
              approvedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [
                schema.serverItemOverride.serverId,
                schema.serverItemOverride.kind,
                schema.serverItemOverride.itemName,
              ],
              set: {
                reviewState: sql`excluded.review_state`,
                approvedHash: sql`excluded.approved_hash`,
                approvedDef: sql`excluded.approved_def`,
                approvedAt: sql`excluded.approved_at`,
              },
              // R4: only where nobody has an opinion yet. A changed definition keeps its old
              // approval and therefore stays `changed` — auto-approval never re-blesses it.
              setWhere: sql`${schema.serverItemOverride.reviewState} is null`,
            });
        }
      }
      if (tofu) {
        await tx
          .update(schema.servers)
          .set({ firstEnabledAt: new Date() })
          .where(and(eq(schema.servers.id, srv.id), sql`${schema.servers.firstEnabledAt} is null`));
      }
    });
  };

  const off = o.engine.events.on('server:catalog', ({ name }) => {
    queue = queue
      .then(() => record(name))
      .catch((err: unknown) =>
        o.log.error(
          {
            evt: 'integrity.record_failed',
            server: name,
            err: err instanceof Error ? err.message : String(err),
          },
          'truth write failed',
        ),
      );
  });
  return { stop: off, idle: () => queue };
}
