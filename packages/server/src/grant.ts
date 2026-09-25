import { z } from 'zod';
import type { Route } from './scope.js';

export type Grant =
  | { kind: 'all' }
  | { kind: 'groups'; ids: readonly string[] }
  | { kind: 'servers'; ids: readonly string[] };

const Ids = z.array(z.uuid()).min(1);

/** R2: exactly one of these shapes lives in the key's server-only `permissions`. */
const Permissions = z.union([
  z.strictObject({ mcp: z.tuple([z.literal('all')]) }),
  z.strictObject({ groups: Ids }),
  z.strictObject({ servers: Ids }),
]);

/** Parsed on every read; anything else is null and denies (§5.2). */
export function parseGrant(raw: unknown): Grant | null {
  const r = Permissions.safeParse(raw);
  if (!r.success) return null;
  const p = r.data;
  if ('mcp' in p) return { kind: 'all' };
  if ('groups' in p) return { kind: 'groups', ids: p.groups };
  return { kind: 'servers', ids: p.servers };
}

export function toPermissions(g: Grant): Record<string, string[]> {
  if (g.kind === 'all') return { mcp: ['all'] };
  return { [g.kind]: [...g.ids] };
}

/**
 * Full containment (§4.2). Pure, no I/O. Relies on `route.serverIds` being
 * complete — a partial list would silently turn this into partial containment
 * (the GHSA-454m-4vm6-842f class).
 */
export function checkGrant(grant: Grant, route: Route): 'ok' | 'insufficient' {
  switch (grant.kind) {
    case 'all':
      return 'ok';
    case 'groups':
      // R3: a group grant is good on its own group's route and nowhere else.
      return route.groupId !== undefined && grant.ids.includes(route.groupId)
        ? 'ok'
        : 'insufficient';
    case 'servers':
      return route.serverIds.every((id) => grant.ids.includes(id)) ? 'ok' : 'insufficient';
  }
}
