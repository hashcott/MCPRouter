# MCPRouter P2a — Groups, Scoped Keys, Call-Time Enforcement and Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two keys scoped to two groups see different tool sets (4 vs 2); calling a tool outside your scope returns a response **byte-identical** to calling a tool that was never defined; per-tool disable is enforced at call time; every call writes an audit row.

**Architecture:** Groups are one record per membership (`group_server`: selection + alias). The server process keeps an in-memory **snapshot** (servers, groups, members) refreshed by the P1c poller, and resolves a route to a `ResolvedScope` with a **pure** `resolveTarget(snapshot, target)`. Authorization is a **pure** `checkGrant(grant, route)` with full containment. The fixed check order is `authenticate → resolveTarget (null → 404) → checkGrant (→ 403) → per-principal concurrency (→ 429) → handle`. Core stays authz-free: it only ever sees an already-authorized scope, and its one predicate (`isExposed`) already enforces per-tool disable at call time — P2a only feeds it the overrides. Audit rows go through a bounded in-process queue, off the call path.

**Tech Stack:** inherited — drizzle, zod, Hono, better-auth apiKey, MCP SDK 1.30.0. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-19-mcprouter-design.md` — §4.1 (one predicate, one not-found message), §4.2 (check order, full containment, 404 byte-identical, limits), §5.3 (grant `all | groups[] | servers[]` on the key), §6 (`groups`, `group_server`, `server_item_override`, `audit_event`), §8 "Audit" (metadata mode, queue, spill), §13 P2 (demo).

**Scope:** P2 is split in two. **P2a (this plan):** the non-guardrail half of §13 P2. **P2b (next):** the guardrail half — definition hashes and the 4 columns, `isExposed` AND-clause, `first_enabled_at`, response cap, `policy_rule` + `evaluate` + the stamped seam gate, the ~12 invariant cases.

## Global Constraints

Inherited, still binding:

- pnpm 10.12.4 · ESM · `nodenext` · relative imports end in `.js`.
- `packages/core` never depends on `hono`/`better-auth`; `grep -rn session packages/core/src --exclude=auth.ts` stays empty.
- Coverage gates: global 70/70/60 · `packages/core/src/security/**` 90/85 · `packages/server/src/mcp/**` 85/75.
- `retry: 0` · Conventional Commits · **no `Co-Authored-By`** · do not push · no bare word `env` between spaces in shell commands (local hook).
- `pnpm build && pnpm lint && pnpm test` before each commit, lint at **zero warnings**; `pnpm db:check` right after a commit that adds a migration.
- Enumerations are `text` + CHECK (§11.7). Slug CHECK `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` (§6).

From the spec, verbatim:

- "Thứ tự check cố định và test được: `authenticate` → `gateway.resolveTarget(principal, target)` (null → `404`) → `checkGrant(grant, scope)` (fail → `403` + `WWW-Authenticate: Bearer error="insufficient_scope"`) → handle." (§4.2)
- "Group không tồn tại … trả về **404 byte-identical**." (§4.2)
- "Full-containment là hàm thuần `checkGrant(grant, scope): 'ok' | 'insufficient'` trong `grant.ts`, không I/O, có test bảng chân trị vét cạn. Grant theo server vào route group chỉ pass nếu **mọi** thành viên `scope.serverIds` nằm trong grant." `serverIds` is **complete-or-throw** (§4.2).
- "semaphore concurrency per-principal (mặc định 8, vượt → `429` + `Retry-After: 1`)" (§4.2).
- Override per item keyed on the **bare** upstream name (§4.1, §6).
- Audit `metadata` mode (default): **key names** of arguments (`input_keys text[]`), byte count — never values. Queue capped 10 000, flushed every 250 ms or at 200 rows by one multi-row INSERT; a failed flush re-queues once; DB down and queue full → each row to the log at `error` with `evt:'audit.spill'`; SIGTERM flushes with a 5 s budget (§8).
- `audit_event`: no partition, **no foreign key**, denormalized names (§6).

## Rulings

- **R1 — keys are still minted by the CLI.** §5.2's `POST /api/keys` enforces "requested grant ⊆ creator's reach"; its creator is a human session, and humans arrive with the console (P3). The CLI holds database credentials — operator-level by construction. P1c R3 carries forward to P3.
- **R2 — grant encoding in `permissions`:** exactly one of `{ mcp: ['all'] }`, `{ groups: [uuid, …] }`, `{ servers: [uuid, …] }`. IDs, not slugs, so a future rename cannot widen a key. Anything else parses to `null` → 401 (fail closed, as P1c).
- **R3 — a `groups` grant passes only on the routes of those groups.** On `/mcp` or `/mcp/s/:server` it is `insufficient`, even if the server happens to be a member: containment is checked against the route the client asked for, and the pure function has no membership I/O. A `servers` grant passes on any route whose complete `serverIds` it contains.
- **R4 — "complete" `serverIds`** means every server in the route regardless of `enabled` or load status: `/mcp` → every server row; a group → every member. A disabled member still counts against a `servers` grant.
- **R5 — only `kind = 'tool'` overrides reach the Engine.** P1a's `ServerConfigBase.tools` is the only override the engine models; the table's CHECK already admits `prompt`/`resource` for the console (P3) and the engine grows the two maps then.
- **R6 — `--server fs=a,b` selects tools a and b and NO prompts or resources.** An explicit item list means "only these"; leaving prompts/resources at `'all'` would expose items the operator never chose. `--server fs` alone is all/all/all.
- **R7 — aliases:** the column, its CHECK and its per-group unique index ship now (§6 "alias in one record"); no P2a writer sets one, so the cross-member label-collision check lands with the first writer (P3's group editor).
- **R8 — the per-principal limit is a counter, not a queue:** over the limit answers 429 immediately (§4.2), so a `Map<principalId, number>` is the whole mechanism.
- **R9 — audit `full` mode, retention jobs and `call_rollup_1m` are P4** (observability: "activity log persist + retention job"). P2a writes `metadata` rows only.
- **R10 — the response cap (1 MB, P1c R7) moves to P2b** with "cap response upstream", where it belongs in §13.

## Review Focus

1. **A `servers` grant containing only some members of a group** requested on that group's route → 403, never a partial catalog. Pinned in Task 3's truth table and Task 7's demo.
2. **A tool disabled while a client holds a stale `tools/list`** → the call fails with the one not-found message (call-time enforcement). Pinned in Task 7.
3. **Two concurrent requests from the same principal above the limit** → the excess gets 429 `Retry-After: 1`, and the counter returns to zero afterwards (no leak on error paths). Pinned in Task 5.
4. **The database is down when audit flushes** → rows re-queue once, then spill to the log at `error`; no tool call waits on it. Pinned in Task 6.
5. **A `group_server` selection edited by hand into something malformed** (`{"tools": 5}`) → that member exposes nothing (fail closed) and the group still resolves. Pinned in Task 4.

---

## File Structure

| file | responsibility |
| ---- | -------------- |
| `packages/core/src/db/schema/groups.ts` | `groups`, `group_server`, `server_item_override` |
| `packages/core/src/db/schema/audit.ts` | `audit_event` |
| `packages/core/src/db/store.ts` | loader also returns tool overrides |
| `packages/server/src/grant.ts` | `parseGrant`, `toPermissions`, `checkGrant` — pure |
| `packages/server/src/scope.ts` | `Snapshot`, `Target`, `Route`, `resolveTarget` — pure |
| `packages/server/src/servers-sync.ts` | builds the snapshot on each poll |
| `packages/server/src/mcp/legacy.ts` | resolve + callResolved, one audit record per call |
| `packages/server/src/app.ts` | `/mcp/g/:group`, `/mcp/s/:server`, 403, 429 |
| `packages/server/src/audit.ts` | `AuditWriter` — bounded queue, batch insert, spill |
| `packages/cli/src/commands.ts` | `groups add`, `servers tool`, scoped `keys create` |

---

### Task 1: Tables — groups, memberships, overrides, audit

**Files:**
- Create: `packages/core/src/db/schema/groups.ts`, `packages/core/src/db/schema/audit.ts`
- Modify: `packages/core/src/db/schema/index.ts`
- Create: `drizzle/0004_*.sql` (generated)
- Test: `packages/core/src/db/groups-schema.itest.ts`

**Interfaces:**
- Consumes: `servers`, `timestamps()` (P1b).
- Produces: tables `groups (id, slug)`, `groupServer (groupId, serverId, alias, tools, prompts, resources)`, `serverItemOverride (serverId, kind, itemName, enabled, description)`, `auditEvent (id, at, evt, requestId, principalId, keyId, route, server, item, outcome, durationMs, inputKeys, inputBytes, error)`, all in `schema` under those keys; `type Selection = 'all' | string[]`; `type Outcome = 'ok' | 'error' | 'denied' | 'not_found' | 'timeout'`.

- [ ] **Step 1: Write the failing integration test**

`packages/core/src/db/groups-schema.itest.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import type { Pool } from 'pg';
import { createPool, runMigrations } from './migrate.js';

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = createPool(pg.getConnectionUri());
  await runMigrations(pool, pino({ level: 'silent' }));
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
});

const violates = (constraint: string) => expect.objectContaining({ code: '23514', constraint });

async function server(slug: string): Promise<string> {
  const r = await pool.query(
    `insert into servers (slug, config) values ($1, '{"type":"stdio","command":"x"}') returning id`,
    [slug],
  );
  return r.rows[0].id;
}
async function group(slug: string): Promise<string> {
  const r = await pool.query('insert into groups (slug) values ($1) returning id', [slug]);
  return r.rows[0].id;
}

describe('groups', () => {
  it('rejects a slug with the separator', async () => {
    await expect(group('a__b')).rejects.toEqual(violates('groups_slug_fmt'));
  });
});

describe('group_server', () => {
  it('defaults every selection to "all"', async () => {
    const g = await group('g-default');
    const s = await server('s-default');
    await pool.query('insert into group_server (group_id, server_id) values ($1, $2)', [g, s]);
    const r = await pool.query('select tools, prompts, resources from group_server where group_id = $1', [g]);
    expect(r.rows[0]).toEqual({ tools: 'all', prompts: 'all', resources: 'all' });
  });

  it('rejects a selection that is neither "all" nor an array', async () => {
    const g = await group('g-bad');
    const s = await server('s-bad');
    await expect(
      pool.query(`insert into group_server (group_id, server_id, tools) values ($1, $2, '5')`, [g, s]),
    ).rejects.toEqual(violates('group_server_selection'));
  });

  it('rejects an alias with the separator, and a duplicate alias within one group', async () => {
    const g = await group('g-alias');
    const [a, b] = [await server('s-a'), await server('s-b')];
    await expect(
      pool.query(`insert into group_server (group_id, server_id, alias) values ($1, $2, 'x__y')`, [g, a]),
    ).rejects.toEqual(violates('group_server_alias_fmt'));
    await pool.query(`insert into group_server (group_id, server_id, alias) values ($1, $2, 'same')`, [g, a]);
    await expect(
      pool.query(`insert into group_server (group_id, server_id, alias) values ($1, $2, 'same')`, [g, b]),
    ).rejects.toEqual(expect.objectContaining({ code: '23505' }));
  });

  it('goes away with its group and with its server', async () => {
    const [g1, g2] = [await group('g-c1'), await group('g-c2')];
    const s = await server('s-c');
    await pool.query('insert into group_server (group_id, server_id) values ($1, $3), ($2, $3)', [g1, g2, s]);
    await pool.query('delete from groups where id = $1', [g1]);
    await pool.query('delete from servers where id = $1', [s]);
    const left = await pool.query('select 1 from group_server where server_id = $1', [s]);
    expect(left.rowCount).toBe(0);
  });
});

describe('server_item_override', () => {
  it('is keyed by (server, kind, bare name) and admits only known kinds', async () => {
    const s = await server('s-o');
    await pool.query(`insert into server_item_override (server_id, kind, item_name, enabled) values ($1, 'tool', 'rm', false)`, [s]);
    await expect(
      pool.query(`insert into server_item_override (server_id, kind, item_name) values ($1, 'tool', 'rm')`, [s]),
    ).rejects.toEqual(expect.objectContaining({ code: '23505' }));
    await expect(
      pool.query(`insert into server_item_override (server_id, kind, item_name) values ($1, 'widget', 'x')`, [s]),
    ).rejects.toEqual(violates('server_item_override_kind'));
  });
});

describe('audit_event', () => {
  it('accepts a denormalized row with no foreign keys and survives its server being deleted', async () => {
    const s = await server('s-audit');
    await pool.query(
      `insert into audit_event (evt, principal_id, key_id, route, server, item, outcome, duration_ms, input_keys, input_bytes)
       values ('tool.call', 'u1', 'k1', 'g/team', 's-audit', 'read', 'ok', 12, '{path}', 20)`,
    );
    await pool.query('delete from servers where id = $1', [s]);
    const r = await pool.query(`select server, input_keys from audit_event where server = 's-audit'`);
    expect(r.rows).toEqual([{ server: 's-audit', input_keys: ['path'] }]);
  });

  it('rejects an unknown outcome', async () => {
    await expect(
      pool.query(`insert into audit_event (evt, outcome) values ('tool.call', 'meh')`),
    ).rejects.toEqual(violates('audit_event_outcome'));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project integration packages/core/src/db/groups-schema.itest.ts`
Expected: FAIL — `relation "groups" does not exist`.

- [ ] **Step 3: Implement**

`packages/core/src/db/schema/groups.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamps } from './_shared.js';
import { servers } from './servers.js';

/** BARE upstream item names, or every item. */
export type Selection = 'all' | string[];

const SLUG = `'^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'`;
const selectionOk = (col: unknown) =>
  sql`(${col} = '"all"'::jsonb or jsonb_typeof(${col}) = 'array')`;

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('groups_slug_uq').on(t.slug),
    check('groups_slug_fmt', sql`${t.slug} ~ ${sql.raw(SLUG)}`),
  ],
);

/** Membership + item selection + alias in one record (§6). */
export const groupServer = pgTable(
  'group_server',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    /** Renames the server on this group's route only. */
    alias: text('alias'),
    tools: jsonb('tools').$type<Selection>().notNull().default(sql`'"all"'::jsonb`),
    prompts: jsonb('prompts').$type<Selection>().notNull().default(sql`'"all"'::jsonb`),
    resources: jsonb('resources').$type<Selection>().notNull().default(sql`'"all"'::jsonb`),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.serverId] }),
    // The cascade probe from servers, and "which groups is this server in".
    index('group_server_server_idx').on(t.serverId),
    // NULLs are distinct, so any number of members may go un-aliased.
    uniqueIndex('group_server_alias_uq').on(t.groupId, t.alias),
    check('group_server_alias_fmt', sql`${t.alias} is null or ${t.alias} ~ ${sql.raw(SLUG)}`),
    check(
      'group_server_selection',
      sql`${selectionOk(t.tools)} and ${selectionOk(t.prompts)} and ${selectionOk(t.resources)}`,
    ),
  ],
);

/** Per-item enable + description override, keyed on the BARE upstream name (§4.1, §6). */
export const serverItemOverride = pgTable(
  'server_item_override',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'tool' | 'prompt' | 'resource'>().notNull(),
    itemName: text('item_name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    description: text('description'),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.serverId, t.kind, t.itemName] }),
    check('server_item_override_kind', sql`${t.kind} in ('tool', 'prompt', 'resource')`),
  ],
);
```

`packages/core/src/db/schema/audit.ts`:

```ts
import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export type Outcome = 'ok' | 'error' | 'denied' | 'not_found' | 'timeout';

/**
 * The ONLY audit log (§6). No partition and NO foreign key, names denormalized:
 * revoking a key or deleting a server can neither erase nor blank the trail.
 */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    evt: text('evt').notNull(),
    requestId: text('request_id'),
    principalId: text('principal_id'),
    keyId: text('key_id'),
    /** 'all' | 'g/<group>' | 's/<server>' */
    route: text('route'),
    server: text('server'),
    item: text('item'),
    outcome: text('outcome').$type<Outcome>(),
    durationMs: integer('duration_ms'),
    /** metadata mode: argument KEY NAMES only, never values (§8). */
    inputKeys: text('input_keys').array(),
    inputBytes: integer('input_bytes'),
    error: text('error'),
  },
  (t) => [
    index('audit_event_at_idx').on(t.at),
    check(
      'audit_event_outcome',
      sql`${t.outcome} is null or ${t.outcome} in ('ok', 'error', 'denied', 'not_found', 'timeout')`,
    ),
  ],
);
```

`packages/core/src/db/schema/index.ts` — add:

```ts
import { auditEvent } from './audit.js';
import { groupServer, groups, serverItemOverride } from './groups.js';

export { auditEvent, groupServer, groups, serverItemOverride };
export type { Outcome } from './audit.js';
export type { Selection } from './groups.js';
```

and extend the barrel: `export const schema = { systemSetting, servers, secrets, groups, groupServer, serverItemOverride, auditEvent, ...auth };`

`packages/core/src/index.ts` — after the `schema` export line add:

```ts
export type { Outcome, Selection } from './db/schema/index.js';
```

- [ ] **Step 4: Generate and run**

Run: `pnpm build && pnpm db:generate` — Expected: `drizzle/0004_<name>.sql` with four `CREATE TABLE`s; open it and confirm the defaults render as `DEFAULT '"all"'::jsonb` and the identity column as `GENERATED ALWAYS AS IDENTITY`.
Run: `pnpm vitest run --project integration packages/core/src/db` — Expected: PASS.

- [ ] **Step 5: Gates and commit**

Run: `pnpm lint && pnpm test`

```bash
git add packages/core drizzle
git commit -m "feat(core): groups, memberships, item overrides and the audit table"
pnpm db:check
```

---

### Task 2: The loader carries tool overrides to the Engine

**Files:**
- Modify: `packages/core/src/db/store.ts`
- Test: `packages/core/src/db/store.itest.ts` (extend)

**Interfaces:**
- Consumes: `serverItemOverride` (Task 1).
- Produces: every `ServerConfig` from `loadServerConfigs` carries `tools: Record<bareName, { enabled: boolean; description?: string }>` built from `kind = 'tool'` override rows (empty object when none).

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/db/store.itest.ts`:

```ts
describe('tool overrides', () => {
  it('reach the Engine config keyed by bare name; other kinds do not', async () => {
    const id = await createServer(db, KR1, { slug: 'ov', config: { type: 'stdio', command: 'x' } });
    await pool.query(
      `insert into server_item_override (server_id, kind, item_name, enabled, description) values
         ($1, 'tool', 'rm', false, null),
         ($1, 'tool', 'ls', true, 'List files, carefully'),
         ($1, 'prompt', 'p', false, null)`,
      [id],
    );
    const cfg = (await loadServerConfigs(db, KR1)).configs.find((c) => c.name === 'ov');
    expect(cfg?.tools).toEqual({
      rm: { enabled: false },
      ls: { enabled: true, description: 'List files, carefully' },
    });
  });

  it('a server with no overrides gets an empty map', async () => {
    await createServer(db, KR1, { slug: 'plain', config: { type: 'stdio', command: 'x' } });
    const cfg = (await loadServerConfigs(db, KR1)).configs.find((c) => c.name === 'plain');
    expect(cfg?.tools).toEqual({});
  });
});
```

And update the P1b round-trip expectation in `round-trips into the Engine shape` so both expected configs contain `tools: {}`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run --project integration packages/core/src/db/store.itest.ts`
Expected: FAIL — `tools` is `undefined`.

- [ ] **Step 3: Implement**

In `packages/core/src/db/store.ts`:

- import: `import { and, eq, inArray } from 'drizzle-orm';` and add `serverItemOverride` to the schema import.
- after `secretRows` is loaded:

```ts
  // R5: only tool overrides — the Engine models no prompt/resource overrides yet.
  const overrideRows =
    rows.length === 0
      ? []
      : await db
          .select()
          .from(serverItemOverride)
          .where(
            and(
              eq(serverItemOverride.kind, 'tool'),
              inArray(
                serverItemOverride.serverId,
                rows.map((r) => r.id),
              ),
            ),
          );
```

- inside the loop, before `out.configs.push(`:

```ts
      const tools = Object.fromEntries(
        overrideRows
          .filter((o) => o.serverId === row.id)
          .map((o) => [
            o.itemName,
            o.description === null
              ? { enabled: o.enabled }
              : { enabled: o.enabled, description: o.description },
          ]),
      );
```

- `const base = { name: row.slug, enabled: row.enabled, credentialMode: row.credentialMode, tools };`

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm build && pnpm vitest run --project integration packages/core/src/db/store.itest.ts`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

Run: `pnpm lint && pnpm test`

```bash
git add packages/core
git commit -m "feat(core): loader carries per-tool overrides to the Engine"
```

---

### Task 3: `checkGrant`, `resolveTarget` and scoped key auth — pure

**Files:**
- Create: `packages/server/src/grant.ts`, `packages/server/src/grant.test.ts`
- Create: `packages/server/src/scope.ts`, `packages/server/src/scope.test.ts`
- Modify: `packages/server/src/auth.ts`, `packages/server/src/auth.itest.ts`

**Interfaces:**
- Consumes: `type ResolvedScope`, `type ServerSelection`, `type Selection` (core); `authenticateKey`, `MachinePrincipal`, `KEY_GRANT_ALL` (P1c).
- Produces:
  - `grant.ts`: `type Grant = { kind: 'all' } | { kind: 'groups'; ids: readonly string[] } | { kind: 'servers'; ids: readonly string[] }`; `parseGrant(raw: unknown): Grant | null`; `toPermissions(g: Grant): Record<string, string[]>`; `checkGrant(grant: Grant, route: Route): 'ok' | 'insufficient'`
  - `scope.ts`: `type Target = { kind: 'all' } | { kind: 'group'; slug: string } | { kind: 'server'; slug: string }`; `type Member = { serverId: string; serverSlug: string; alias?: string | undefined; tools: Selection; prompts: Selection; resources: Selection }`; `type Snapshot = { servers: readonly { id: string; slug: string; enabled: boolean }[]; groups: ReadonlyMap<string, { id: string; members: readonly Member[] }> }`; `EMPTY_SNAPSHOT`; `type Route = { scope: ResolvedScope; serverIds: readonly string[]; groupId?: string | undefined; label: string }`; `resolveTarget(snap: Snapshot, target: Target): Route | null`
  - `auth.ts`: `type KeyAuth = { principal: MachinePrincipal; keyId: string; grant: Grant }`; `authenticateKey(auth, header): Promise<KeyAuth | null>` (**return type changes**); `KEY_GRANT_ALL` becomes `toPermissions({ kind: 'all' })`

- [ ] **Step 1: Write the failing unit tests**

`packages/server/src/grant.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { checkGrant, parseGrant, toPermissions, type Grant } from './grant.js';
import type { Route } from './scope.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const G = '00000000-0000-4000-8000-0000000000aa';
const H = '00000000-0000-4000-8000-0000000000bb';

const route = (serverIds: string[], groupId?: string): Route => ({
  scope: { key: 'k', servers: [], flatten: false },
  serverIds,
  groupId,
  label: 'x',
});

describe('parseGrant', () => {
  it.each([
    [{ mcp: ['all'] }, { kind: 'all' }],
    [{ groups: [G] }, { kind: 'groups', ids: [G] }],
    [{ servers: [A, B] }, { kind: 'servers', ids: [A, B] }],
  ])('parses %j', (raw, grant) => expect(parseGrant(raw)).toEqual(grant));

  it.each([
    ['null', null],
    ['empty object', {}],
    ['unknown mcp value', { mcp: ['read'] }],
    ['two kinds at once', { mcp: ['all'], groups: [G] }],
    ['an empty list', { groups: [] }],
    ['a slug instead of an id', { servers: ['fs'] }],
    ['an extra key', { servers: [A], note: ['x'] }],
  ])('fails closed on %s', (_n, raw) => expect(parseGrant(raw)).toBeNull());

  it('toPermissions round-trips', () => {
    for (const g of [{ kind: 'all' }, { kind: 'groups', ids: [G] }, { kind: 'servers', ids: [A] }] as Grant[]) {
      expect(parseGrant(toPermissions(g))).toEqual(g);
    }
  });
});

// The exhaustive truth table (§4.2). Routes: all = {A,B}; group G = {A,B}; group H = {A};
// empty group E; server A.
describe('checkGrant', () => {
  const all = route([A, B]);
  const groupG = route([A, B], G);
  const groupH = route([A], H);
  const empty = route([], '00000000-0000-4000-8000-0000000000ee');
  const serverA = route([A]);

  it.each([
    ['all', { kind: 'all' }, all, 'ok'],
    ['all', { kind: 'all' }, groupG, 'ok'],
    ['all', { kind: 'all' }, serverA, 'ok'],
    ['groups[G] on G', { kind: 'groups', ids: [G] }, groupG, 'ok'],
    ['groups[G] on H', { kind: 'groups', ids: [G] }, groupH, 'insufficient'],
    ['groups[G,H] on H', { kind: 'groups', ids: [G, H] }, groupH, 'ok'],
    ['groups[G] on all (R3)', { kind: 'groups', ids: [G] }, all, 'insufficient'],
    ['groups[G] on server A (R3)', { kind: 'groups', ids: [G] }, serverA, 'insufficient'],
    ['servers[A] on server A', { kind: 'servers', ids: [A] }, serverA, 'ok'],
    ['servers[A] on H={A}', { kind: 'servers', ids: [A] }, groupH, 'ok'],
    ['servers[A] on G={A,B} — containment, not partial', { kind: 'servers', ids: [A] }, groupG, 'insufficient'],
    ['servers[A] on all={A,B}', { kind: 'servers', ids: [A] }, all, 'insufficient'],
    ['servers[A,B] on all', { kind: 'servers', ids: [A, B] }, all, 'ok'],
    ['servers[A] on an empty group', { kind: 'servers', ids: [A] }, empty, 'ok'],
    ['groups[G] on an empty group', { kind: 'groups', ids: [G] }, empty, 'insufficient'],
  ] as const)('%s → %s', (_n, grant, r, expected) => {
    expect(checkGrant(grant as Grant, r)).toBe(expected);
  });
});
```

`packages/server/src/scope.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EMPTY_SNAPSHOT, resolveTarget, type Snapshot } from './scope.js';

const snap: Snapshot = {
  servers: [
    { id: 'id-fs', slug: 'fs', enabled: true },
    { id: 'id-gh', slug: 'gh', enabled: true },
    { id: 'id-off', slug: 'off', enabled: false },
  ],
  groups: new Map([
    [
      'eng',
      {
        id: 'id-eng',
        members: [
          { serverId: 'id-fs', serverSlug: 'fs', tools: 'all', prompts: 'all', resources: 'all' },
          { serverId: 'id-off', serverSlug: 'off', tools: 'all', prompts: 'all', resources: 'all' },
          { serverId: 'id-gh', serverSlug: 'gh', alias: 'git', tools: ['create_issue'], prompts: [], resources: [] },
        ],
      },
    ],
    ['empty', { id: 'id-empty', members: [] }],
  ]),
};

describe('resolveTarget', () => {
  it('all: enabled servers in the scope, EVERY server in serverIds (R4)', () => {
    const r = resolveTarget(snap, { kind: 'all' });
    expect(r?.scope.servers.map((s) => s.serverName)).toEqual(['fs', 'gh']);
    expect(r?.serverIds).toEqual(['id-fs', 'id-gh', 'id-off']);
    expect(r?.scope.flatten).toBe(false);
    expect(r?.label).toBe('all');
    expect(r?.groupId).toBeUndefined();
  });

  it('group: members with their selection and alias; complete serverIds', () => {
    const r = resolveTarget(snap, { kind: 'group', slug: 'eng' });
    expect(r?.groupId).toBe('id-eng');
    expect(r?.label).toBe('g/eng');
    expect(r?.serverIds).toEqual(['id-fs', 'id-off', 'id-gh']);
    expect(r?.scope.flatten).toBe(false);
    expect(r?.scope.servers).toEqual([
      { serverName: 'fs', tools: 'all', prompts: 'all', resources: 'all' },
      { serverName: 'off', tools: 'all', prompts: 'all', resources: 'all' },
      { serverName: 'gh', alias: 'git', tools: ['create_issue'], prompts: [], resources: [] },
    ]);
  });

  it('an empty group resolves to an empty scope, not to null and never to "all"', () => {
    const r = resolveTarget(snap, { kind: 'group', slug: 'empty' });
    expect(r?.scope.servers).toEqual([]);
    expect(r?.serverIds).toEqual([]);
  });

  it('server: one server, flattened', () => {
    const r = resolveTarget(snap, { kind: 'server', slug: 'gh' });
    expect(r?.scope.flatten).toBe(true);
    expect(r?.scope.servers.map((s) => s.serverName)).toEqual(['gh']);
    expect(r?.serverIds).toEqual(['id-gh']);
    expect(r?.label).toBe('s/gh');
  });

  it.each([
    [{ kind: 'group', slug: 'nope' }],
    [{ kind: 'server', slug: 'nope' }],
  ] as const)('unknown %j → null', (t) => expect(resolveTarget(snap, t)).toBeNull());

  it('scope keys differ between routes and are stable for one route', () => {
    const a = resolveTarget(snap, { kind: 'group', slug: 'eng' })?.scope.key;
    expect(a).toBe(resolveTarget(snap, { kind: 'group', slug: 'eng' })?.scope.key);
    expect(a).not.toBe(resolveTarget(snap, { kind: 'all' })?.scope.key);
    expect(resolveTarget(snap, { kind: 'server', slug: 'fs' })?.scope.key).not.toBe(
      resolveTarget(snap, { kind: 'group', slug: 'eng' })?.scope.key,
    );
  });

  it('the empty snapshot serves an empty "all"', () => {
    expect(resolveTarget(EMPTY_SNAPSHOT, { kind: 'all' })?.scope.servers).toEqual([]);
  });
});
```

Run: `pnpm vitest run packages/server/src/grant.test.ts packages/server/src/scope.test.ts`
Expected: FAIL — cannot resolve `./grant.js` / `./scope.js`.

- [ ] **Step 2: Implement `scope.ts` and `grant.ts`**

`packages/server/src/scope.ts`:

```ts
import type { ResolvedScope, Selection, ServerSelection } from '@mcprouter/core';

export type Target =
  | { kind: 'all' }
  | { kind: 'group'; slug: string }
  | { kind: 'server'; slug: string };

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
```

`packages/server/src/grant.ts`:

```ts
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
```

Run: `pnpm vitest run packages/server/src/grant.test.ts packages/server/src/scope.test.ts`
Expected: PASS.

- [ ] **Step 3: Scoped key auth — failing test first**

In `packages/server/src/auth.itest.ts`:

- every `expect(await authenticateKey(auth, …)).toEqual({ id, isAdmin: false })` becomes `expect((await authenticateKey(auth, …))?.principal).toEqual({ id, isAdmin: false })`; `?.isAdmin` becomes `?.principal.isAdmin`.
- in `rejects a key minted without the P1 grant`, replace the `mint(id)` (no permissions) case as-is (still null) and keep `{ mcp: ['read'] }` (still null).
- add:

```ts
  it('carries the key id and a scoped grant', async () => {
    const id = await user('operator');
    const g = '00000000-0000-4000-8000-0000000000aa';
    const key = await mint(id, { groups: [g] });
    const a = await authenticateKey(auth, `Bearer ${key}`);
    expect(a?.grant).toEqual({ kind: 'groups', ids: [g] });
    expect(a?.keyId).toMatch(/.+/);
    expect(a?.principal).toEqual({ id, isAdmin: false });
  });
```

- in the `fails closed on permissions edited to %s` table, add `['a slug where an id belongs', '{"servers":["fs"]}']`.

Run: `pnpm vitest run --project integration packages/server/src/auth.itest.ts`
Expected: FAIL — `principal` undefined on the result.

- [ ] **Step 4: Implement in `auth.ts`**

- remove the local `Grant` zod schema and `KEY_GRANT_ALL`'s literal; import `parseGrant`, `toPermissions`, `type Grant` from `./grant.js`:

```ts
/** The unscoped grant. Scoped keys are minted with toPermissions({ kind: 'groups' | 'servers', … }). */
export const KEY_GRANT_ALL = toPermissions({ kind: 'all' });

export type KeyAuth = { principal: MachinePrincipal; keyId: string; grant: Grant };
```

- `authenticateKey` returns `Promise<KeyAuth | null>`; its tail becomes:

```ts
  const grant = parseGrant(r.key.permissions);
  if (grant === null) return null;
  // §5.2: a machine credential is never admin, whatever its owner's role.
  return { principal: { id: r.key.referenceId, isAdmin: false }, keyId: r.key.id, grant };
```

`packages/server/src/app.ts` still types `McpDeps.authenticate` as returning `MachinePrincipal`; **Task 5** changes it. To keep this task's build green, adapt the call site in `main.ts` for now:

```ts
    authenticate: async (header) => (await authenticateKey(auth, header))?.principal ?? null,
```

and in `packages/cli/src/demo.itest.ts` the same adaptation for its `authenticate`.

- [ ] **Step 5: Run, gates, commit**

Run: `pnpm build && pnpm vitest run packages/server && pnpm vitest run --project integration packages/server/src/auth.itest.ts packages/cli`
Expected: PASS.

Run: `pnpm lint && pnpm test`

```bash
git add packages/server packages/cli
git commit -m "feat(server): pure checkGrant and resolveTarget; keys carry an all/groups/servers grant"
```

---

### Task 4: The poller builds the snapshot

**Files:**
- Modify: `packages/server/src/servers-sync.ts`, `packages/server/src/servers-sync.itest.ts`
- Modify: `packages/server/src/index.ts`, `packages/server/src/main.ts`, `packages/server/src/app.mcp.test.ts`, `packages/cli/src/demo.itest.ts` (call-site updates only)

**Interfaces:**
- Consumes: `schema.groups`, `schema.groupServer`, `schema.servers`, `type Selection` (core); `Snapshot`, `Member`, `EMPTY_SNAPSHOT`, `resolveTarget` (Task 3).
- Produces: `ServerSync = { snapshot(): Snapshot; refresh(): Promise<void>; stop(): void }` — **`scopeAll()` and `EMPTY_SCOPE` are removed**; callers use `resolveTarget(sync.snapshot(), { kind: 'all' })`. `@mcprouter/server` exports `resolveTarget`, `EMPTY_SNAPSHOT`, `type Snapshot`, `type Target`, `type Route`, `checkGrant`, `parseGrant`, `toPermissions`, `type Grant`, `type KeyAuth`.

- [ ] **Step 1: Write the failing test**

In `packages/server/src/servers-sync.itest.ts`:

- imports gain `import { resolveTarget } from './scope.js';`
- replace `const names = (s: ServerSync) => s.scopeAll().servers.map((x) => x.serverName);` with:

```ts
const names = (s: ServerSync) =>
  resolveTarget(s.snapshot(), { kind: 'all' })?.scope.servers.map((x) => x.serverName) ?? [];
```

- in `applies the table before it resolves`, replace the `scopeAll().flatten` line with `expect(resolveTarget(sync.snapshot(), { kind: 'all' })?.scope.flatten).toBe(false);`
- append:

```ts
describe('groups in the snapshot', () => {
  it('a group added while running resolves with its members and selections', async () => {
    const g = await pool.query(`insert into groups (slug) values ('team') returning id`);
    await pool.query(
      `insert into group_server (group_id, server_id, tools, prompts, resources)
       select $1, id, '["t"]', '[]', '[]' from servers where slug = 'fs'`,
      [g.rows[0].id],
    );
    await vi.waitFor(() =>
      expect(resolveTarget(sync.snapshot(), { kind: 'group', slug: 'team' })?.scope.servers).toEqual([
        { serverName: 'fs', tools: ['t'], prompts: [], resources: [] },
      ]),
    );
  });

  it('a group with no members resolves empty', async () => {
    await pool.query(`insert into groups (slug) values ('nobody')`);
    await vi.waitFor(() =>
      expect(resolveTarget(sync.snapshot(), { kind: 'group', slug: 'nobody' })?.serverIds).toEqual([]),
    );
  });

  it('a malformed selection edited by hand exposes nothing for that member, and the group still resolves', async () => {
    // The CHECK admits any array; an array of non-strings is still wrong.
    await pool.query(`update group_server set tools = '[1, 2]' where group_id = (select id from groups where slug = 'team')`);
    await vi.waitFor(() =>
      expect(resolveTarget(sync.snapshot(), { kind: 'group', slug: 'team' })?.scope.servers[0]?.tools).toEqual([]),
    );
  });
});
```

Run: `pnpm vitest run --project integration packages/server/src/servers-sync.itest.ts`
Expected: FAIL — `sync.snapshot is not a function`.

- [ ] **Step 2: Implement**

`packages/server/src/servers-sync.ts`:

- imports: `import { asc, eq } from 'drizzle-orm';`, `import { z } from 'zod';`, `schema` and `type Selection` from `@mcprouter/core` (drop `ResolvedScope`), and `import { EMPTY_SNAPSHOT, type Member, type Snapshot } from './scope.js';`
- replace the `ServerSync` type and delete `EMPTY_SCOPE`:

```ts
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
```

- the fingerprint query also hashes the new tables:

```ts
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
```

- replace `let scope = EMPTY_SCOPE;` with `let snap: Snapshot = EMPTY_SNAPSHOT;`, and replace the block that builds `scope` (after `await o.engine.applyConfig(configs);`) with:

```ts
    const loaded = new Map(configs.map((c) => [c.name, c.enabled]));
    const serverRows = await o.db
      .select({ id: schema.servers.id, slug: schema.servers.slug })
      .from(schema.servers)
      .orderBy(asc(schema.servers.slug));
    const memberRows = await o.db
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

    const groups = new Map<string, { id: string; members: Member[] }>();
    for (const r of memberRows) {
      const g = groups.get(r.groupSlug) ?? { id: r.groupId, members: [] };
      groups.set(r.groupSlug, g);
      if (r.serverId === null || r.serverSlug === null) continue; // a group with no members
      g.members.push({
        serverId: r.serverId,
        serverSlug: r.serverSlug,
        ...(r.alias === null ? {} : { alias: r.alias }),
        tools: selection(r.tools),
        prompts: selection(r.prompts),
        resources: selection(r.resources),
      });
    }
    snap = {
      // Only servers the Engine holds; one whose secrets failed to open is not routable.
      servers: serverRows
        .filter((r) => loaded.has(r.slug))
        .map((r) => ({ id: r.id, slug: r.slug, enabled: loaded.get(r.slug) === true })),
      groups,
    };
```

- the return becomes `return { snapshot: () => snap, refresh, stop: () => clearInterval(timer) };`

`packages/server/src/index.ts` — replace the servers-sync export line and add:

```ts
export { startServerSync, type ServerSync } from './servers-sync.js';
export { checkGrant, parseGrant, toPermissions, type Grant } from './grant.js';
export { EMPTY_SNAPSHOT, resolveTarget, type Route, type Snapshot, type Target } from './scope.js';
```

and add `type KeyAuth` to the `./auth.js` export.

Call-site updates (behavior unchanged, `/mcp` still serves `{kind:'all'}` until Task 5):

- `packages/server/src/main.ts`: import `EMPTY_SNAPSHOT, resolveTarget` from `./scope.js` instead of `EMPTY_SCOPE`; `scopeAll: () => resolveTarget(sync?.snapshot() ?? EMPTY_SNAPSHOT, { kind: 'all' })?.scope ?? { key: 'all:', servers: [], flatten: false },`
- `packages/cli/src/demo.itest.ts`: `scopeAll: () => resolveTarget(sync.snapshot(), { kind: 'all' })!.scope,` with `resolveTarget` imported from `@mcprouter/server`.

- [ ] **Step 3: Run, gates, commit**

Run: `pnpm build && pnpm vitest run --project integration packages/server packages/cli`
Expected: PASS.

Run: `pnpm lint && pnpm test`

```bash
git add packages/server packages/cli
git commit -m "feat(server): the poller builds a groups snapshot; routes resolve from it"
```

---

### Task 5: Routes, 403, 429, and one audit record per call

**Files:**
- Modify: `packages/server/src/mcp/legacy.ts`, `packages/server/src/mcp/legacy.test.ts`
- Modify: `packages/server/src/app.ts`, `packages/server/src/app.mcp.test.ts`
- Modify: `packages/server/src/config.ts`, `packages/server/src/config.test.ts`
- Modify: `packages/server/src/main.ts`, `packages/cli/src/demo.itest.ts` (call sites)

**Interfaces:**
- Consumes: `resolveTarget`, `Route`, `Target` (Task 3/4); `checkGrant` (Task 3); `KeyAuth` (Task 3); `type ToolDecision`, `type Outcome` (core).
- Produces:
  - `legacy.ts`: `type CallRecord = { server: string | null; item: string; outcome: Outcome; durationMs: number; inputKeys: string[]; inputBytes: number; error: string | null }`; `McpCall.audit?: ((r: CallRecord) => void) | undefined`
  - `app.ts`: `McpDeps = { authenticate(h): Promise<KeyAuth | null>; engine: Engine; resolve(t: Target): Route | null; timeoutMs: number; maxInflight: number; audit(row: AuditRow): void; authHandler(req): Promise<Response> }` — `scopeAll` removed
  - `type AuditRow = CallRecord & { evt: 'tool.call'; requestId: string | null; principalId: string; keyId: string; route: string }` (exported from `app.ts`; Task 6's writer consumes it)
  - `Config.maxInflight: number` (`MCP_MAX_INFLIGHT`, default 8, min 1)

- [ ] **Step 1: Failing tests — legacy audit records**

In `packages/server/src/mcp/legacy.test.ts`:

- `call` gains an optional audit sink:

```ts
const records: CallRecord[] = [];
const call = (timeoutMs = 5_000): McpCall => ({
  engine,
  scope,
  principal,
  timeoutMs,
  audit: (r) => records.push(r),
});
```

(import `type CallRecord` from `./legacy.js`)

- append:

```ts
describe('audit records', () => {
  it('one per call: server, bare item, outcome, argument KEY NAMES and size — never values', async () => {
    records.length = 0;
    const c = await client();
    await c.callTool({ name: 'fs__echo', arguments: { text: 'secret-value' } });
    await c.callTool({ name: 'fs__boom', arguments: {} });
    await expect(c.callTool({ name: 'fs__nope', arguments: {} })).rejects.toThrow();
    await c.close();
    expect(records.map((r) => [r.server, r.item, r.outcome])).toEqual([
      ['fs', 'echo', 'ok'],
      ['fs', 'boom', 'error'],
      [null, 'fs__nope', 'not_found'],
    ]);
    expect(records[0]?.inputKeys).toEqual(['text']);
    expect(records[0]?.inputBytes).toBe(Buffer.byteLength('{"text":"secret-value"}'));
    expect(JSON.stringify(records)).not.toContain('secret-value');
    expect(records[1]?.error).toContain('upstream exploded');
  });

  it('a call past the deadline is recorded as a timeout', async () => {
    records.length = 0;
    const c = await client(100);
    await c.callTool({ name: 'fs__slow', arguments: {} });
    await c.close();
    expect(records[0]?.outcome).toBe('timeout');
  });
});
```

Run: `pnpm vitest run packages/server/src/mcp/legacy.test.ts`
Expected: FAIL — no records.

- [ ] **Step 2: Implement in `legacy.ts`**

- imports gain `type Outcome`, `type ToolDecision` from `@mcprouter/core`.
- add:

```ts
export type CallRecord = {
  server: string | null;
  item: string;
  outcome: Outcome;
  durationMs: number;
  /** metadata mode (§8): argument key names and byte size, never values. */
  inputKeys: string[];
  inputBytes: number;
  error: string | null;
};
```

- `McpCall` gains `audit?: ((r: CallRecord) => void) | undefined;`
- replace the `CallToolRequestSchema` handler with the resolve / callResolved split (§11.4 — P2b's policy gate lands between the two):

```ts
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    const started = Date.now();
    const args = r.params.arguments ?? {};
    const rec = {
      server: null as string | null,
      item: r.params.name,
      inputKeys: Object.keys(args),
      inputBytes: Buffer.byteLength(JSON.stringify(args), 'utf8'),
    };
    const done = (outcome: Outcome, error: string | null = null): void =>
      call.audit?.({ ...rec, outcome, durationMs: Date.now() - started, error });

    let decision: ToolDecision;
    try {
      decision = engine.resolve(scope, r.params.name);
    } catch (err) {
      if (err instanceof ToolUnavailableError) done('not_found');
      return notFound(err);
    }
    rec.server = decision.server;
    rec.item = decision.bare;
    try {
      const res = (await engine.callResolved(decision, {
        scope,
        principal,
        name: r.params.name,
        args,
        signal,
      })) as CallToolResult;
      done(res.isError === true ? 'error' : 'ok');
      return res;
    } catch (err) {
      if (err instanceof ToolUnavailableError) {
        done('not_found');
        return notFound(err);
      }
      // An upstream failure is the tool's result, not the gateway's: the model sees it.
      const text = err instanceof Error ? err.message : 'tool call failed';
      done(signal.aborted ? 'timeout' : 'error', text);
      return { content: [{ type: 'text', text }], isError: true };
    }
  });
```

Run: `pnpm build && pnpm vitest run packages/server/src/mcp/legacy.test.ts`
Expected: PASS.

- [ ] **Step 3: Failing tests — routes, 403, 429**

Rewrite the setup of `packages/server/src/app.mcp.test.ts` to the new `McpDeps` and add cases. Replace the `beforeAll` app construction's `mcp:` block and the `principal`/`scope` constants with:

```ts
import { resolveTarget, type Snapshot } from './scope.js';
import type { AuditRow } from './app.js';
import type { KeyAuth } from './auth.js';

const FS = '00000000-0000-4000-8000-0000000000f5';
const TEAM = '00000000-0000-4000-8000-0000000000e1';
const snap: Snapshot = {
  servers: [{ id: FS, slug: 'fs', enabled: true }],
  groups: new Map([
    ['team', { id: TEAM, members: [{ serverId: FS, serverSlug: 'fs', tools: 'all', prompts: 'all', resources: 'all' }] }],
  ]),
};
const keys: Record<string, KeyAuth> = {
  'Bearer good': { principal: { id: 'u1', isAdmin: false }, keyId: 'k1', grant: { kind: 'all' } },
  'Bearer team': { principal: { id: 'u2', isAdmin: false }, keyId: 'k2', grant: { kind: 'groups', ids: [TEAM] } },
};
const audited: AuditRow[] = [];
let gate: (() => void) | undefined;
```

and the `mcp:` block:

```ts
    mcp: {
      authenticate: async (h) => keys[h ?? ''] ?? null,
      engine,
      resolve: (t) => resolveTarget(snap, t),
      timeoutMs: 5_000,
      maxInflight: 1,
      audit: (row) => audited.push(row),
      authHandler: async () => new Response('from-better-auth'),
    },
```

In the `FakeUpstream('fs', …)` tool list add a tool that waits for the test to release it:

```ts
{ name: 'hold', handler: () => new Promise<string>((r) => { gate = () => r('released'); }) },
```

Update existing expectations: `/mcp` lists `['fs__echo', 'fs__hold']`; the 404 table drops `/mcp/g/team` and `/mcp/s/fs` (they exist now) and keeps `/mcp/nope`, `/mcp/smart`, and adds `/mcp/g/nope`, `/mcp/s/nope`, `/mcp/g/team/extra`.

Add:

```ts
const rpc = (method: string, params: unknown = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
const post = (path: string, auth: string, body: string) =>
  app.request(path, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body,
  });

describe('scoped routes', () => {
  it('a group key works on its group route and is 403 insufficient_scope elsewhere', async () => {
    expect((await post('/mcp/g/team', 'Bearer team', rpc('tools/list'))).status).toBe(200);
    for (const path of ['/mcp', '/mcp/s/fs']) {
      const res = await post(path, 'Bearer team', rpc('tools/list'));
      expect(res.status).toBe(403);
      expect(res.headers.get('www-authenticate')).toBe('Bearer error="insufficient_scope"');
    }
  });

  it('an unknown group and an unknown path are the same 404, byte for byte', async () => {
    const a = await post('/mcp/g/nope', 'Bearer good', rpc('tools/list'));
    const b = await post('/mcp/nope', 'Bearer good', rpc('tools/list'));
    expect([a.status, await a.text()]).toEqual([b.status, await b.text()]);
  });

  it('a server route flattens names', async () => {
    const res = await post('/mcp/s/fs', 'Bearer good', rpc('tools/list'));
    expect(JSON.stringify(await res.json())).toContain('"name":"echo"');
  });
});

describe('per-principal concurrency', () => {
  it('the request over the limit gets 429 Retry-After: 1, and the slot frees afterwards', async () => {
    const first = post('/mcp', 'Bearer good', rpc('tools/call', { name: 'fs__hold', arguments: {} }));
    await vi.waitFor(() => expect(gate).toBeDefined());
    const second = await post('/mcp', 'Bearer good', rpc('tools/list'));
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('1');
    // Another principal is not affected.
    expect((await post('/mcp/g/team', 'Bearer team', rpc('tools/list'))).status).toBe(200);
    gate?.();
    expect((await first).status).toBe(200);
    expect((await post('/mcp', 'Bearer good', rpc('tools/list'))).status).toBe(200);
  });
});

describe('audit rows', () => {
  it('each call becomes a row with principal, key and route', async () => {
    audited.length = 0;
    await post('/mcp/g/team', 'Bearer team', rpc('tools/call', { name: 'fs__echo', arguments: { a: 1 } }));
    expect(audited).toEqual([
      expect.objectContaining({
        evt: 'tool.call',
        principalId: 'u2',
        keyId: 'k2',
        route: 'g/team',
        server: 'fs',
        item: 'echo',
        outcome: 'ok',
        inputKeys: ['a'],
      }),
    ]);
  });
});
```

In `packages/server/src/config.test.ts` add:

```ts
  it('defaults MCP_MAX_INFLIGHT to 8', () => {
    const d = parseConfig(valid);
    expect(d.ok && d.config.maxInflight).toBe(8);
    expect(parseConfig({ ...valid, MCP_MAX_INFLIGHT: '0' }).ok).toBe(false);
  });
```

Run: `pnpm vitest run packages/server`
Expected: FAIL — `resolve`/`maxInflight` unknown, routes 404, no 403/429.

- [ ] **Step 4: Implement in `app.ts` and `config.ts`**

`packages/server/src/config.ts`: `MCP_MAX_INFLIGHT: z.coerce.number().int().min(1).default(8),` · `readonly maxInflight: number;` · `maxInflight: v.MCP_MAX_INFLIGHT,` · `toJSON` gains `maxInflight: this.maxInflight,`.

`packages/server/src/app.ts`:

- imports: replace `type MachinePrincipal` import with `import type { KeyAuth } from './auth.js';`; add `import { checkGrant } from './grant.js';`, `import type { Route, Target } from './scope.js';`, `import { handleMcp, type CallRecord } from './mcp/legacy.js';` (replacing the old `handleMcp` import); drop `ResolvedScope` and `Principal` from the core import if unused.
- replace `McpDeps` and add `AuditRow`:

```ts
export type AuditRow = CallRecord & {
  evt: 'tool.call';
  requestId: string | null;
  principalId: string;
  keyId: string;
  route: string;
};

export interface McpDeps {
  /** `Authorization` header → key principal and grant, or null. */
  authenticate: (authorization: string | undefined) => Promise<KeyAuth | null>;
  engine: Engine;
  /** Pure route resolution over the current snapshot; null → 404. */
  resolve: (target: Target) => Route | null;
  timeoutMs: number;
  /** Per-principal concurrent MCP requests (§4.2, default 8). */
  maxInflight: number;
  audit: (row: AuditRow) => void;
  /** better-auth's fetch handler. */
  authHandler: (req: Request) => Promise<Response>;
}
```

- in `mountMcp`, `guarded`'s handler type becomes `(c: Context, a: KeyAuth) => …`, it sets `ctx.principal = a.principal.id` and passes `a`; replace the single `app.post('/mcp', …)` with:

```ts
  const inflight = new Map<string, number>();

  // §4.2, in this order: authenticate → resolve (404) → checkGrant (403) → limit (429) → handle.
  const serve = (target: (c: Context) => Target) =>
    guarded(async (c, a) => {
      const route = mcp.resolve(target(c));
      if (route === null) return c.json({ error: 'not_found' }, 404);
      if (checkGrant(a.grant, route) !== 'ok') {
        return c.json({ error: 'insufficient_scope' }, 403, {
          'WWW-Authenticate': 'Bearer error="insufficient_scope"',
        });
      }
      const who = a.principal.id;
      const n = inflight.get(who) ?? 0;
      if (n >= mcp.maxInflight) {
        return c.json({ error: 'too_many_requests' }, 429, { 'Retry-After': '1' });
      }
      inflight.set(who, n + 1);
      try {
        return await handleMcp(c.req.raw, {
          engine: mcp.engine,
          scope: route.scope,
          principal: a.principal,
          timeoutMs: mcp.timeoutMs,
          audit: (r) =>
            mcp.audit({
              ...r,
              evt: 'tool.call',
              requestId: currentContext()?.requestId ?? null,
              principalId: who,
              keyId: a.keyId,
              route: route.label,
            }),
        });
      } finally {
        const left = (inflight.get(who) ?? 1) - 1;
        if (left === 0) inflight.delete(who);
        else inflight.set(who, left);
      }
    });

  app.post('/mcp', serve(() => ({ kind: 'all' })));
  app.post('/mcp/g/:group', serve((c) => ({ kind: 'group', slug: c.req.param('group') ?? '' })));
  app.post('/mcp/s/:server', serve((c) => ({ kind: 'server', slug: c.req.param('server') ?? '' })));
```

(the GET/DELETE 405, `all('/mcp')`, `all('/mcp/*')` 404 and `/api/auth` lines stay as they are, after these.)

Call sites:

- `packages/server/src/main.ts`: `authenticate: (header) => authenticateKey(auth, header),` · `resolve: (t) => resolveTarget(sync?.snapshot() ?? EMPTY_SNAPSHOT, t),` · `maxInflight: config.maxInflight,` · `audit: () => {},` (Task 6 replaces it) · remove `scopeAll`.
- `packages/cli/src/demo.itest.ts`: same `authenticate`, `resolve: (t) => resolveTarget(sync.snapshot(), t)`, `maxInflight: 8`, `audit: () => {}`.

- [ ] **Step 5: Run, coverage check, gates, commit**

Run: `pnpm build && pnpm vitest run packages/server && pnpm vitest run --project integration packages/cli`
Expected: PASS.

Run: `pnpm lint && pnpm vitest run --coverage`
Expected: exit 0 (the `server/src/mcp/**` gate included).

```bash
git add packages/server packages/cli
git commit -m "feat(server): group and server routes; 403 insufficient_scope; per-principal 429; audit record per call"
```

---

### Task 6: `AuditWriter` — bounded queue, batch insert, spill

**Files:**
- Create: `packages/server/src/audit.ts`, `packages/server/src/audit.test.ts`, `packages/server/src/audit.itest.ts`
- Modify: `packages/server/src/main.ts`, `packages/server/src/index.ts`

**Interfaces:**
- Consumes: `AuditRow` (Task 5); `schema.auditEvent`, `type Db` (core).
- Produces: `class AuditWriter { constructor(o: { db: Db; log: Logger; cap?: number; batch?: number; intervalMs?: number }); push(row: AuditRow): void; start(): void; flush(): Promise<void>; stop(budgetMs?: number): Promise<void> }`, exported from `@mcprouter/server`.

- [ ] **Step 1: Write the failing tests**

`packages/server/src/audit.test.ts` (no database — a pool pointed at a closed port):

```ts
import { describe, expect, it } from 'vitest';
import { pino, type Logger } from 'pino';
import { createDb, createPool } from '@mcprouter/core';
import type { AuditRow } from './app.js';
import { AuditWriter } from './audit.js';

const row = (item: string): AuditRow => ({
  evt: 'tool.call',
  requestId: null,
  principalId: 'u1',
  keyId: 'k1',
  route: 'all',
  server: 'fs',
  item,
  outcome: 'ok',
  durationMs: 1,
  inputKeys: [],
  inputBytes: 2,
  error: null,
});

function capture(): { log: Logger; spilled: unknown[] } {
  const spilled: unknown[] = [];
  const log = pino({ level: 'silent' });
  log.error = ((o: { evt?: string; row?: unknown }) => {
    if (o.evt === 'audit.spill') spilled.push(o.row);
  }) as Logger['error'];
  return { log, spilled };
}

const deadDb = () => createDb(createPool('postgres://u:p@127.0.0.1:1/none'));

describe('AuditWriter without a database', () => {
  it('re-queues a failed batch once, then spills each row to the log', async () => {
    const { log, spilled } = capture();
    const w = new AuditWriter({ db: deadDb(), log });
    w.push(row('a'));
    w.push(row('b'));
    await w.flush(); // fails, re-queued
    expect(spilled).toEqual([]);
    await w.flush(); // fails again, spilled
    expect(spilled).toEqual([row('a'), row('b')]);
  });

  it('spills immediately when the queue is full, and never throws at the caller', () => {
    const { log, spilled } = capture();
    const w = new AuditWriter({ db: deadDb(), log, cap: 2, batch: 100 });
    w.push(row('a'));
    w.push(row('b'));
    expect(() => w.push(row('c'))).not.toThrow();
    expect(spilled).toEqual([row('c')]);
  });

  it('stop() spills whatever it could not persist within the budget', async () => {
    const { log, spilled } = capture();
    const w = new AuditWriter({ db: deadDb(), log });
    w.push(row('a'));
    await w.stop(2_000);
    expect(spilled).toEqual([row('a')]);
  });
});
```

`packages/server/src/audit.itest.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import type { Pool } from 'pg';
import { createDb, createPool, runMigrations } from '@mcprouter/core';
import type { AuditRow } from './app.js';
import { AuditWriter } from './audit.js';

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = createPool(pg.getConnectionUri());
  await runMigrations(pool, pino({ level: 'silent' }));
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
});

const row = (item: string): AuditRow => ({
  evt: 'tool.call',
  requestId: 'r1',
  principalId: 'u1',
  keyId: 'k1',
  route: 'g/team',
  server: 'fs',
  item,
  outcome: 'ok',
  durationMs: 3,
  inputKeys: ['path'],
  inputBytes: 10,
  error: null,
});

describe('AuditWriter', () => {
  it('flushes on the timer, in one multi-row insert', async () => {
    const w = new AuditWriter({ db: createDb(pool), log: pino({ level: 'silent' }), intervalMs: 20 });
    w.start();
    w.push(row('a'));
    w.push(row('b'));
    await vi.waitFor(async () => {
      const r = await pool.query(`select item, input_keys, route from audit_event order by id`);
      expect(r.rows).toEqual([
        { item: 'a', input_keys: ['path'], route: 'g/team' },
        { item: 'b', input_keys: ['path'], route: 'g/team' },
      ]);
    });
    await w.stop();
  });

  it('flushes as soon as a batch fills, without waiting for the timer', async () => {
    await pool.query('delete from audit_event');
    const w = new AuditWriter({ db: createDb(pool), log: pino({ level: 'silent' }), batch: 2, intervalMs: 60_000 });
    w.push(row('x'));
    w.push(row('y'));
    await vi.waitFor(async () => {
      const r = await pool.query('select count(*)::int as n from audit_event');
      expect(r.rows[0].n).toBe(2);
    });
    await w.stop();
  });

  it('stop() drains the queue', async () => {
    await pool.query('delete from audit_event');
    const w = new AuditWriter({ db: createDb(pool), log: pino({ level: 'silent' }), intervalMs: 60_000 });
    w.push(row('z'));
    await w.stop();
    const r = await pool.query('select count(*)::int as n from audit_event');
    expect(r.rows[0].n).toBe(1);
  });
});
```

Run: `pnpm vitest run packages/server/src/audit.test.ts`
Expected: FAIL — cannot resolve `./audit.js`.

- [ ] **Step 2: Implement**

`packages/server/src/audit.ts`:

```ts
import type { Logger } from 'pino';
import { schema, type Db } from '@mcprouter/core';
import type { AuditRow } from './app.js';

type Entry = { row: AuditRow; retried: boolean };

/**
 * Audit writes stay OFF the tool-call path (§8): a bounded in-process queue,
 * flushed every `intervalMs` or as soon as `batch` rows wait, by one multi-row
 * INSERT. A failed batch is re-queued once; a second failure — or a full queue —
 * spills each row to the log at `error` (evt 'audit.spill'): it lands in
 * stdout/Docker logs instead of vanishing. SIGKILL/OOM lose the queue; that is
 * the documented trade-off, not a bug.
 */
export class AuditWriter {
  readonly #o: { db: Db; log: Logger; cap: number; batch: number; intervalMs: number };
  #queue: Entry[] = [];
  #timer: NodeJS.Timeout | undefined;
  #flushing: Promise<void> | undefined;

  constructor(o: { db: Db; log: Logger; cap?: number; batch?: number; intervalMs?: number }) {
    this.#o = { cap: 10_000, batch: 200, intervalMs: 250, ...o };
  }

  push(row: AuditRow): void {
    if (this.#queue.length >= this.#o.cap) {
      this.#spill(row);
      return;
    }
    this.#queue.push({ row, retried: false });
    if (this.#queue.length >= this.#o.batch) void this.flush();
  }

  start(): void {
    this.#timer = setInterval(() => void this.flush(), this.#o.intervalMs);
    this.#timer.unref();
  }

  /** Serialized: a flush already running is joined, never run twice at once. */
  flush(): Promise<void> {
    this.#flushing ??= this.#drain().finally(() => {
      this.#flushing = undefined;
    });
    return this.#flushing;
  }

  async stop(budgetMs = 5_000): Promise<void> {
    clearInterval(this.#timer);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.flush().then(() => this.flush()), // the second pass retries a re-queued batch once
      new Promise<void>((r) => {
        timer = setTimeout(r, budgetMs);
      }),
    ]);
    clearTimeout(timer);
    for (const e of this.#queue.splice(0)) this.#spill(e.row);
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, this.#o.batch);
      try {
        await this.#o.db.insert(schema.auditEvent).values(batch.map((e) => e.row));
      } catch (err) {
        this.#o.log.warn(
          { evt: 'audit.flush_failed', rows: batch.length, err: err instanceof Error ? err.message : String(err) },
          'audit flush failed',
        );
        for (const e of batch) if (e.retried) this.#spill(e.row);
        this.#queue.unshift(...batch.filter((e) => !e.retried).map((e) => ({ row: e.row, retried: true })));
        return; // the next tick tries again
      }
    }
  }

  #spill(row: AuditRow): void {
    this.#o.log.error({ evt: 'audit.spill', row }, 'audit row not persisted');
  }
}
```

`packages/server/src/index.ts` — add `export { AuditWriter } from './audit.js';` and `type AuditRow` to the `./app.js` export.

`packages/server/src/main.ts`:

- `import { AuditWriter } from './audit.js';`
- after `const auth = …`: `const audit = new AuditWriter({ db, log });` and `audit.start();`
- `mcp.audit: (row) => audit.push(row),`
- in `shutdown`, after the `server.close` drain and before `sync?.stop();`: `await audit.stop();`

- [ ] **Step 3: Run, gates, commit**

Run: `pnpm build && pnpm vitest run packages/server/src/audit.test.ts && pnpm vitest run --project integration packages/server/src/audit.itest.ts`
Expected: PASS.

Run: `pnpm lint && pnpm test`

```bash
git add packages/server
git commit -m "feat(server): audit writer off the call path — bounded queue, batch insert, spill to log"
```

---

### Task 7: CLI — groups, per-tool disable, scoped keys; the P2 demo as a test

**Files:**
- Modify: `packages/cli/src/commands.ts`, `packages/cli/src/commands.test.ts`, `packages/cli/src/main.ts`
- Test: `packages/cli/src/scoped.itest.ts`

**Interfaces:**
- Consumes: `toPermissions`, `type Grant`, `AuditWriter`, `resolveTarget`, `createApp`, … (server); `FakeUpstream`, `fakeFactory` (core test seam).
- Produces:
  - `parseGroupAdd(argv: string[]): { slug: string; members: { server: string; tools: 'all' | string[] }[] }`
  - `addGroup(pool, input): Promise<string>` — one transaction; unknown server slug → `CliError`
  - `setToolEnabled(pool, input: { server: string; tool: string; enabled: boolean }): Promise<void>`
  - `createKey(auth, pool, input: { email: string; name: string; groups?: string[]; servers?: string[] })` — **extended**: resolves slugs to ids, `groups` and `servers` together → `CliError`, neither → all

- [ ] **Step 1: Failing unit tests**

Append to `packages/cli/src/commands.test.ts` (import `parseGroupAdd`):

```ts
describe('parseGroupAdd', () => {
  it('--server alone selects everything; --server s=a,b selects those tools', () => {
    expect(parseGroupAdd(['eng', '--server', 'fs', '--server', 'gh=create_issue,list_issues'])).toEqual({
      slug: 'eng',
      members: [
        { server: 'fs', tools: 'all' },
        { server: 'gh', tools: ['create_issue', 'list_issues'] },
      ],
    });
  });

  it('a group may start empty', () => {
    expect(parseGroupAdd(['empty'])).toEqual({ slug: 'empty', members: [] });
  });

  it.each([
    ['no slug', []],
    ['an empty tool list', ['g', '--server', 'fs=']],
    ['an unknown flag', ['g', '--alias', 'x']],
  ])('rejects %s', (_n, argv) => expect(() => parseGroupAdd(argv)).toThrow(CliError));
});
```

Run: `pnpm vitest run packages/cli/src/commands.test.ts` — Expected: FAIL (`parseGroupAdd` is not exported).

- [ ] **Step 2: Implement the commands**

Append to `packages/cli/src/commands.ts` (add `toPermissions`, `type Grant` to the `@mcprouter/server` import):

```ts
export function parseGroupAdd(argv: string[]): {
  slug: string;
  members: { server: string; tools: 'all' | string[] }[];
} {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: { server: { type: 'string', multiple: true, default: [] } },
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  const [slug] = parsed.positionals;
  if (slug === undefined) throw new CliError('usage: mcprouter groups add <slug> [--server <slug>[=tool,tool]]…');
  const members = parsed.values.server.map((spec) => {
    const eq = spec.indexOf('=');
    if (eq < 0) return { server: spec, tools: 'all' as const };
    const tools = spec
      .slice(eq + 1)
      .split(',')
      .filter((t) => t.length > 0);
    if (tools.length === 0) throw new CliError(`--server ${spec}: name at least one tool after '='`);
    return { server: spec.slice(0, eq), tools };
  });
  return { slug, members };
}

async function idsOf(pool: pg.Pool, table: 'servers' | 'groups', slugs: string[]): Promise<string[]> {
  const r = await pool.query<{ id: string; slug: string }>(
    `select id, slug from ${table} where slug = any($1)`,
    [slugs],
  );
  const bySlug = new Map(r.rows.map((x) => [x.slug, x.id]));
  return slugs.map((s) => {
    const id = bySlug.get(s);
    if (id === undefined) throw new CliError(`no ${table === 'servers' ? 'server' : 'group'} named ${s}`);
    return id;
  });
}

/** R6: an explicit tool list selects ONLY those tools — no prompts, no resources. */
export async function addGroup(
  pool: pg.Pool,
  input: { slug: string; members: { server: string; tools: 'all' | string[] }[] },
): Promise<string> {
  const serverIds = await idsOf(
    pool,
    'servers',
    input.members.map((m) => m.server),
  );
  const client = await pool.connect();
  try {
    await client.query('begin');
    const g = await client.query<{ id: string }>('insert into groups (slug) values ($1) returning id', [
      input.slug,
    ]);
    const groupId = g.rows[0]?.id as string;
    for (const [i, m] of input.members.entries()) {
      const narrow = m.tools !== 'all';
      await client.query(
        `insert into group_server (group_id, server_id, tools, prompts, resources)
         values ($1, $2, $3, $4, $4)`,
        [groupId, serverIds[i], JSON.stringify(m.tools), JSON.stringify(narrow ? [] : 'all')],
      );
    }
    await client.query('commit');
    return groupId;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function setToolEnabled(
  pool: pg.Pool,
  input: { server: string; tool: string; enabled: boolean },
): Promise<void> {
  const [serverId] = await idsOf(pool, 'servers', [input.server]);
  await pool.query(
    `insert into server_item_override (server_id, kind, item_name, enabled) values ($1, 'tool', $2, $3)
     on conflict (server_id, kind, item_name) do update set enabled = excluded.enabled, updated_at = now()`,
    [serverId, input.tool, input.enabled],
  );
}
```

Replace `createKey` with:

```ts
/** R1: in P2a the CLI is still the only minter. P3 moves minting to POST /api/keys with the subset check. */
export async function createKey(
  auth: Auth,
  pool: pg.Pool,
  input: { email: string; name: string; groups?: string[]; servers?: string[] },
): Promise<string> {
  const groups = input.groups ?? [];
  const servers = input.servers ?? [];
  if (groups.length > 0 && servers.length > 0) {
    throw new CliError('a key is scoped to groups OR servers, not both');
  }
  const r = await pool.query<{ id: string }>('select id from "user" where email = $1', [input.email]);
  const userId = r.rows[0]?.id;
  if (userId === undefined) {
    throw new CliError(`no user with email ${input.email} — run \`mcprouter users add\` first`);
  }
  const grant: Grant =
    groups.length > 0
      ? { kind: 'groups', ids: await idsOf(pool, 'groups', groups) }
      : servers.length > 0
        ? { kind: 'servers', ids: await idsOf(pool, 'servers', servers) }
        : { kind: 'all' };
  const k = await auth.api.createApiKey({
    body: { name: input.name, userId, permissions: toPermissions(grant) },
  });
  return k.key;
}
```

(`KEY_GRANT_ALL` is no longer imported by the CLI.)

Run: `pnpm build && pnpm vitest run packages/cli/src/commands.test.ts` — Expected: PASS.

- [ ] **Step 3: The entry point**

`packages/cli/src/main.ts`:

- import `addGroup`, `parseGroupAdd`, `setToolEnabled`.
- HELP gains:

```
  groups add <slug> [--server <slug>[=tool,tool]]…   --server s=a,b selects ONLY those tools
  servers tool <server> <tool> --enable | --disable
  keys create --email <e> [--name <n>] [--group <g>]… | [--server <s>]…   (neither: every server)
```

- `keys create` options gain `group: { type: 'string', multiple: true, default: [] }` and `server: { type: 'string', multiple: true, default: [] }`, passed as `groups: values.group, servers: values.server`.
- new branches before the final `else`:

```ts
    } else if (cmd === 'groups' && sub === 'add') {
      process.stdout.write(`${await addGroup(pool, parseGroupAdd(rest))}\n`);
    } else if (cmd === 'servers' && sub === 'tool') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { enable: { type: 'boolean', default: false }, disable: { type: 'boolean', default: false } },
      });
      const [server, tool] = positionals;
      if (server === undefined || tool === undefined || values.enable === values.disable) {
        throw new CliError('usage: mcprouter servers tool <server> <tool> --enable | --disable');
      }
      await setToolEnabled(pool, { server, tool, enabled: values.enable });
```

- [ ] **Step 4: The P2 demo as a test**

`packages/cli/src/scoped.itest.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import { createDb, createPool, createServer, Engine, runMigrations } from '@mcprouter/core';
import {
  AuditWriter,
  authenticateKey,
  createApp,
  createAuth,
  createRegistry,
  parseConfig,
  resolveTarget,
  startServerSync,
  type ServerSync,
} from '@mcprouter/server';
import { FakeUpstream, fakeFactory } from '../../core/test/fake-upstream.js';
import { addGroup, addUser, createKey, parseGroupAdd, setToolEnabled } from './commands.js';

const log = pino({ level: 'silent' });
let pg: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createPool>;
let engine: Engine;
let sync: ServerSync;
let audit: AuditWriter;
let app: ReturnType<typeof createApp>;
let keyA: string;
let keyB: string;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const parsed = parseConfig({
    DATABASE_URL: pg.getConnectionUri(),
    AUTH_SECRET: 'd'.repeat(32),
    PUBLIC_URL: 'http://hub.test',
    MCPR_SECRET_KEYS: `v1:${Buffer.alloc(32, 7).toString('base64url')}`,
  });
  if (!parsed.ok) throw new Error(parsed.issues.join(','));
  const config = parsed.config;
  pool = createPool(config.databaseUrl);
  await runMigrations(pool, log);
  const db = createDb(pool);
  const auth = createAuth({ db, secret: config.authSecret, baseURL: config.publicUrl.href, log });

  const stdio = { type: 'stdio' as const, command: 'x' };
  await createServer(db, config.secretKeys, { slug: 'fs', config: stdio });
  await createServer(db, config.secretKeys, { slug: 'gh', config: stdio });
  // A: fs (3 tools) + gh=create_issue → 4.  B: fs=read_file,list_dir → 2.
  await addGroup(pool, parseGroupAdd(['eng', '--server', 'fs', '--server', 'gh=create_issue']));
  await addGroup(pool, parseGroupAdd(['ops', '--server', 'fs=read_file,list_dir']));
  await addUser(pool, { email: 'a@x.io', name: 'A', role: 'operator' });
  await addUser(pool, { email: 'b@x.io', name: 'B', role: 'operator' });
  keyA = await createKey(auth, pool, { email: 'a@x.io', name: 'a', groups: ['eng'] });
  keyB = await createKey(auth, pool, { email: 'b@x.io', name: 'b', groups: ['ops'] });

  engine = new Engine({
    logger: log,
    connect: fakeFactory({
      fs: new FakeUpstream('fs', [{ name: 'read_file' }, { name: 'write_file' }, { name: 'list_dir' }]),
      gh: new FakeUpstream('gh', [{ name: 'create_issue' }, { name: 'list_issues' }]),
    }),
  });
  sync = await startServerSync({ pool, db, keyring: config.secretKeys, engine, log, intervalMs: 100 });
  audit = new AuditWriter({ db, log, intervalMs: 50 });
  audit.start();
  app = createApp({
    config,
    log,
    pool,
    registry: createRegistry(),
    readiness: { migrationsApplied: true, routesMounted: true },
    mcp: {
      authenticate: (h) => authenticateKey(auth, h),
      engine,
      resolve: (t) => resolveTarget(sync.snapshot(), t),
      timeoutMs: 10_000,
      maxInflight: 8,
      audit: (row) => audit.push(row),
      authHandler: (req) => auth.handler(req),
    },
  });
  await vi.waitFor(() => expect(engine.status().every((s) => s.state === 'ready')).toBe(true));
}, 120_000);

afterAll(async () => {
  await audit?.stop();
  sync?.stop();
  await engine?.shutdown();
  await pool?.end();
  await pg?.stop();
});

const rpc = (id: number, method: string, params: unknown = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params });
function post(path: string, key: string, body: string): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body,
  });
}
async function toolNames(path: string, key: string): Promise<string[]> {
  const res = await post(path, key, rpc(1, 'tools/list'));
  const body = (await res.json()) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((t) => t.name).sort();
}

describe('P2 demo — two keys, two groups', () => {
  it('key A lists 4 tools, key B lists 2', async () => {
    expect(await toolNames('/mcp/g/eng', keyA)).toEqual([
      'fs__list_dir',
      'fs__read_file',
      'fs__write_file',
      'gh__create_issue',
    ]);
    expect(await toolNames('/mcp/g/ops', keyB)).toEqual(['fs__list_dir', 'fs__read_file']);
  });

  it("key B on key A's group is 403 insufficient_scope", async () => {
    const res = await post('/mcp/g/eng', keyB, rpc(1, 'tools/list'));
    expect(res.status).toBe(403);
  });

  it('a tool disabled while A holds a stale list fails at CALL time with the one not-found message', async () => {
    await setToolEnabled(pool, { server: 'gh', tool: 'create_issue', enabled: false });
    await vi.waitFor(async () => expect(await toolNames('/mcp/g/eng', keyA)).toHaveLength(3), {
      timeout: 10_000,
    });
    const res = await post('/mcp/g/eng', keyA, rpc(3, 'tools/call', { name: 'gh__create_issue', arguments: {} }));
    expect(await res.text()).toContain('Tool not found: gh__create_issue');
    await setToolEnabled(pool, { server: 'gh', tool: 'create_issue', enabled: true });
  });

  it("calling an A-only tool with key B is byte-identical to calling a tool that was never defined", async () => {
    const call = rpc(7, 'tools/call', { name: 'fs__write_file', arguments: {} });
    const hidden = await post('/mcp/g/ops', keyB, call);
    const hiddenBytes = await hidden.text();

    // Now make fs__write_file never have existed: remove the server entirely.
    await pool.query(`delete from servers where slug = 'fs'`);
    await vi.waitFor(() => expect(engine.status().map((s) => s.name)).not.toContain('fs'), {
      timeout: 10_000,
    });
    const undefinedCall = await post('/mcp/g/ops', keyB, call);

    expect(hidden.status).toBe(undefinedCall.status);
    expect(hiddenBytes).toBe(await undefinedCall.text());
    expect(hiddenBytes).toContain('Tool not found: fs__write_file');
  });

  it('every call left an audit row with its key and route', async () => {
    await audit.flush();
    const r = await pool.query(
      `select route, item, outcome from audit_event where evt = 'tool.call' order by id`,
    );
    expect(r.rows).toEqual([
      { route: 'g/eng', item: 'gh__create_issue', outcome: 'not_found' },
      { route: 'g/ops', item: 'fs__write_file', outcome: 'not_found' },
      { route: 'g/ops', item: 'fs__write_file', outcome: 'not_found' },
    ]);
  });
});
```

Run: `pnpm build && pnpm vitest run --project integration packages/cli/src/scoped.itest.ts`
Expected: PASS — this is the composition test over Tasks 1–6. Prove it can fail: temporarily make `checkGrant` return `'ok'` for every grant, rebuild, run — Expected: FAIL (the 403 case). Revert, rebuild, run — PASS.

- [ ] **Step 5: Gates and commit**

Run: `pnpm lint && pnpm vitest run --coverage && pnpm db:check`
Expected: exit 0, all coverage gates pass.

```bash
git add packages/cli
git commit -m "feat(cli): groups add, servers tool, scoped keys; the P2 demo as a test"
```

---

## P2a Acceptance

1. `pnpm build && pnpm lint && pnpm vitest run --coverage && pnpm db:check` green, zero warnings.
2. `scoped.itest.ts` passes: 4 vs 2 tools; 403 across groups; call-time disable; hidden ≡ never-defined byte for byte; audit rows written.
3. `grant.test.ts` truth table passes, including `servers[A]` on group `{A,B}` → `insufficient`.

## Self-Review

**Spec coverage (§13 P2 non-guardrail line):** group = membership + selection in one record → T1 (`group_server`), T4 (snapshot), T7 (CLI) · per-tool enable/disable enforced at call time → T2 (overrides reach `isExposed`), T7 test · hidden ≡ nonexistent → core (P1a) + T7 byte-identity test · full containment key↔group → T3 (`checkGrant` truth table), T5 (403) · audit row per call → T5 (record), T6 (writer), T7 (rows) · §4.2 check order and 429 → T5.

**Deferred by design:** everything under "Guardrail +1.25w" → P2b · `POST /api/keys` → P3 (R1) · prompt/resource overrides → P3 (R5) · alias writer + collision check → P3 (R7) · audit `full`, retention, rollup → P4 (R9) · response cap → P2b (R10).

**Type consistency:** `Grant` (T3) is produced by `parseGrant`, consumed by `checkGrant` (T3), `KeyAuth` (T3), `createKey` (T7). `Route`/`Target`/`Snapshot` (T3) are consumed by the poller (T4), `McpDeps.resolve` (T5) and the demo (T7). `CallRecord` (T5) + `AuditRow` (T5) feed `AuditWriter` (T6). `ServerSync.snapshot()` replaces `scopeAll()` in every caller in T4.

**Placeholder scan:** none.
