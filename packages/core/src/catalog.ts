import { ToolUnavailableError } from './errors.js';
import type { ServerRegistry } from './registry.js';
import type { UpstreamServer } from './upstream-server.js';
import {
  SEP,
  type Prompt,
  type ResolvedScope,
  type Resource,
  type ResourceTemplate,
  type ServerConfig,
  type ServerSelection,
  type Tool,
} from './types.js';

export function label(sel: ServerSelection): string {
  return sel.alias ?? sel.serverName;
}

export function project(sel: ServerSelection, bare: string, flatten: boolean): string {
  return flatten ? bare : `${label(sel)}${SEP}${bare}`;
}

type Kind = 'tool' | 'prompt' | 'resource';

/**
 * THE predicate. Three layers, one function, called by BOTH list and call.
 *
 * mcphub needs a filter at list time AND an independent execution gate, and
 * their CVE was the two disagreeing. Here there is nothing to disagree with.
 */
export function isExposed(
  srv: UpstreamServer,
  cfg: ServerConfig,
  sel: ServerSelection,
  kind: Kind,
  bare: string,
): boolean {
  if (!cfg.enabled) return false; // layer 1: server
  if (kind === 'tool' && cfg.tools?.[bare]?.enabled === false) return false; // layer 2: per-tool
  const allow = kind === 'tool' ? sel.tools : kind === 'prompt' ? sel.prompts : sel.resources;
  if (allow !== 'all' && !allow.includes(bare)) return false; // layer 3: scope allowlist
  const catalog = srv.catalog;
  if (catalog === undefined) return false;
  if (kind === 'tool') return catalog.tools.has(bare);
  if (kind === 'prompt') return catalog.prompts.has(bare);
  return catalog.resources.some((r) => r.uri === bare);
}

/**
 * THE resolver, kind-parameterised, and the ONLY construction site of
 * ToolUnavailableError — which is what makes hidden, disabled and never-existed
 * indistinguishable from outside. Prompts resolve by projected name exactly
 * like tools. Resources are NOT prefixed: scan `scope.servers` in order and
 * take the first server whose predicate allows this URI — the same
 * first-in-scope-order rule `flatten` already uses for tools (Ruling P12).
 */
export function resolveByKind(
  scope: ResolvedScope,
  reg: ServerRegistry,
  kind: Kind,
  name: string,
): { sel: ServerSelection; bare: string } {
  if (kind === 'resource') {
    for (const sel of scope.servers) {
      const srv = reg.shared(sel.serverName);
      if (srv !== undefined && isExposed(srv, srv.config, sel, 'resource', name)) {
        return { sel, bare: name };
      }
    }
    throw new ToolUnavailableError(name);
  }
  for (const sel of scope.servers) {
    const prefix = `${label(sel)}${SEP}`;
    const bare = scope.flatten ? name : name.startsWith(prefix) ? name.slice(prefix.length) : null;
    if (bare === null) continue;
    const srv = reg.shared(sel.serverName);
    if (srv !== undefined && isExposed(srv, srv.config, sel, kind, bare)) return { sel, bare };
  }
  throw new ToolUnavailableError(name);
}

/** The `'tool'` wrapper — signature unchanged, so existing callers and tests still pass. */
export function resolveTool(
  scope: ResolvedScope,
  reg: ServerRegistry,
  name: string,
): { sel: ServerSelection; bare: string } {
  return resolveByKind(scope, reg, 'tool', name);
}

// ---- projection, memoized on scope.key + catalogVersion ----------------------

type MemoEntry = {
  tools: Tool[];
  prompts: Prompt[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
};
/**
 * Per-registry, NOT module-global. A global map keyed on `scope.key +
 * catalogVersion` collides across Engine instances: two engines in one process
 * both start their counters low, so identical keys would serve each other's
 * projected tool lists. A module-global mutable cache is also precisely the
 * mcphub pattern this engine exists to avoid. The WeakMap lets a discarded
 * registry take its memo with it.
 */
const memos = new WeakMap<ServerRegistry, Map<string, MemoEntry>>();

function memoOf(reg: ServerRegistry): Map<string, MemoEntry> {
  let m = memos.get(reg);
  if (m === undefined) {
    m = new Map();
    memos.set(reg, m);
  }
  return m;
}

function build(scope: ResolvedScope, reg: ServerRegistry): MemoEntry {
  const out: MemoEntry = { tools: [], prompts: [], resources: [], resourceTemplates: [] };
  for (const sel of scope.servers) {
    const srv = reg.shared(sel.serverName);
    const catalog = srv?.catalog;
    if (srv === undefined || catalog === undefined) continue;

    for (const [bare, tool] of catalog.tools) {
      if (!isExposed(srv, srv.config, sel, 'tool', bare)) continue;
      out.tools.push({ ...tool, name: project(sel, bare, scope.flatten) });
    }
    for (const [bare, prompt] of catalog.prompts) {
      if (!isExposed(srv, srv.config, sel, 'prompt', bare)) continue;
      out.prompts.push({ ...prompt, name: project(sel, bare, scope.flatten) });
    }
    for (const resource of catalog.resources) {
      if (!isExposed(srv, srv.config, sel, 'resource', resource.uri)) continue;
      out.resources.push(resource);
    }
    // Templates have no URI to test item by item, so they follow the selection as a
    // whole: only a server exposing ALL of its resources exposes its templates.
    if (srv.config.enabled && sel.resources === 'all') {
      out.resourceTemplates.push(...catalog.resourceTemplates);
    }
  }
  return out;
}

function entry(scope: ResolvedScope, reg: ServerRegistry): MemoEntry {
  const memo = memoOf(reg);
  const key = `${scope.key}:${reg.catalogVersion}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const built = build(scope, reg);
  // One entry per live scope: drop this scope's older generations.
  for (const k of memo.keys()) if (k.startsWith(`${scope.key}:`)) memo.delete(k);
  memo.set(key, built);
  return built;
}

export function projectTools(scope: ResolvedScope, reg: ServerRegistry): Tool[] {
  return entry(scope, reg).tools;
}
export function projectPrompts(scope: ResolvedScope, reg: ServerRegistry): Prompt[] {
  return entry(scope, reg).prompts;
}
export function projectResources(scope: ResolvedScope, reg: ServerRegistry): Resource[] {
  return entry(scope, reg).resources;
}
export function projectResourceTemplates(
  scope: ResolvedScope,
  reg: ServerRegistry,
): ResourceTemplate[] {
  return entry(scope, reg).resourceTemplates;
}
