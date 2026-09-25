import type { ResolvedScope, Selection, ServerSelection } from '@mcprouter/core';

export type Target =
  { kind: 'all' } | { kind: 'group'; slug: string } | { kind: 'server'; slug: string };

export type Member = {
  serverId: string;
  serverSlug: string;
  alias?: string | undefined;
  tools: Selection;
  prompts: Selection;
  resources: Selection;
};

/** What the poller last applied. Servers are the ones the Engine actually holds. */
export type Snapshot = {
  servers: readonly { id: string; slug: string; enabled: boolean }[];
  groups: ReadonlyMap<string, { id: string; members: readonly Member[] }>;
};

export const EMPTY_SNAPSHOT: Snapshot = { servers: [], groups: new Map() };

export type Route = {
  scope: ResolvedScope;
  /** COMPLETE (§4.2, R4): every server of the route, enabled or not. checkGrant relies on it. */
  serverIds: readonly string[];
  groupId?: string | undefined;
  /** For audit rows: 'all' | 'g/<slug>' | 's/<slug>'. */
  label: string;
};

const everything = (serverName: string): ServerSelection => ({
  serverName,
  tools: 'all',
  prompts: 'all',
  resources: 'all',
});

function scopeOf(servers: ServerSelection[], flatten: boolean): ResolvedScope {
  // A pure function of the fields, as ResolvedScope.key requires.
  return { key: JSON.stringify([servers, flatten]), servers, flatten };
}

/** Pure. null means "no such route" and becomes a 404 byte-identical to any unknown path. */
export function resolveTarget(snap: Snapshot, target: Target): Route | null {
  if (target.kind === 'all') {
    return {
      scope: scopeOf(
        snap.servers.filter((s) => s.enabled).map((s) => everything(s.slug)),
        false,
      ),
      serverIds: snap.servers.map((s) => s.id),
      label: 'all',
    };
  }
  if (target.kind === 'server') {
    const s = snap.servers.find((x) => x.slug === target.slug);
    if (s === undefined) return null;
    return { scope: scopeOf([everything(s.slug)], true), serverIds: [s.id], label: `s/${s.slug}` };
  }
  const g = snap.groups.get(target.slug);
  if (g === undefined) return null;
  return {
    scope: scopeOf(
      g.members.map((m) => ({
        serverName: m.serverSlug,
        ...(m.alias === undefined ? {} : { alias: m.alias }),
        tools: m.tools,
        prompts: m.prompts,
        resources: m.resources,
      })),
      false,
    ),
    serverIds: g.members.map((m) => m.serverId),
    groupId: g.id,
    label: `g/${target.slug}`,
  };
}

/**
 * Slugs whose server id differs between two snapshots: deleted and re-created
 * under the same name. While the Engine swaps to the new config, the old
 * snapshot's routes and memberships would reach the NEW upstream by name.
 */
export function reusedSlugs(prev: Snapshot, next: Snapshot): Set<string> {
  const ids = new Map(next.servers.map((s) => [s.slug, s.id]));
  return new Set(
    prev.servers.filter((s) => ids.has(s.slug) && ids.get(s.slug) !== s.id).map((s) => s.slug),
  );
}
