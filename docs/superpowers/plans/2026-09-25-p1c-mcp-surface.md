# MCPRouter P1c — API Keys, `POST /mcp` and `mcprouter servers add` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real MCP client (Claude Code) points at `https://hub/mcp` with `Authorization: Bearer mcpr_…`, lists the tools of every server added with `mcprouter servers add`, and calls one — through a real upstream process whose credentials were sealed at rest.

**Architecture:** better-auth + `@better-auth/api-key` are **configuration** in one file (`server/src/auth.ts`); we write no key storage, hashing or lookup. `authenticateKey` turns a bearer header into a `Principal` whose `isAdmin` is **always `false`** (§5.2). The era adapter `server/src/mcp/legacy.ts` builds a fresh low-level SDK `Server` **and** a fresh stateless `WebStandardStreamableHTTPServerTransport` per request (`enableJsonResponse: true`), and delegates every handler to the P1a `Engine`. The gateway answers GET/DELETE with 405 itself. A poller keeps the Engine in step with the `servers` table, so a server added by the CLI appears without a restart.

**Tech Stack:** `better-auth@1.7.5` + `@better-auth/api-key@1.7.5` (+ peers `@better-auth/core@1.7.5`, `better-call@1.4.0`, `@better-auth/utils@0.4.2`) · `@modelcontextprotocol/sdk@1.30.0` (now a direct server dependency) · `hono/body-limit` · `node:util` `parseArgs` for the CLI · everything else inherited.

**Spec:** `docs/superpowers/specs/2026-09-19-mcprouter-design.md` — §4.2 (route table, the three measured transport constraints), §5.1–5.3 (credentials, "API key never implies admin", one axis), §13 P1 (the day-21 demo).
**Spikes (measured, binding over the design JSONs):** `docs/superpowers/spikes/spike4.json` (stateless transport), `spike5.json` (apiKey plugin: separate package, `enableSessionForAPIKeys`, `permissions` not `metadata`, rate limit default 10/day, 5 client routes).

**Scope:** third of three P1 plans. P1a (Engine) and P1b (servers/secrets/keyring) are merged.

## Global Constraints

Inherited and still binding:

- **pnpm 10.12.4**, ESM only, `nodenext`, **every relative import ends in `.js`**.
- **`packages/core` never depends on `hono` or `better-auth`.** better-auth lives in `packages/server`. Core only holds the *generated drizzle tables* (§6: `packages/core/src/db/schema/auth.ts`).
- **The string `'session'` must not appear in `packages/core/src`** — the generated better-auth schema has a `session` table. **Ruling R1** below resolves this.
- **CI gates at their final numbers:** global 70/70/60; `packages/core/src/security/**` 90/85; `packages/server/src/mcp/**` lines 85 / branches 75 — **this plan creates the first file under that glob.**
- `retry: 0`. Conventional Commits. **No `Co-Authored-By` trailer.** Do not push. Avoid the bare word `env` surrounded by spaces in shell commands (a local hook blocks it) — say "environment" in commit messages.
- `pnpm build && pnpm lint && pnpm test && pnpm db:check` exit 0 before each commit; `db:check` runs **after** the commit that adds a migration (it checks `git status`).

From the spec, verbatim:

- Transport: `server/webStandardStreamableHttp.js`, `sessionIdGenerator: undefined`, **`enableJsonResponse: true`**, header **`X-Accel-Buffering: no`**, **new `Server` and transport inside every request**, `app.post('/mcp')` for the transport and the gateway itself returns **405 + `Allow: POST`** for GET/DELETE (§4.2).
- `ALL /mcp/*` not matched above → **`404 {"error":"not_found"}`**, bearer-authenticated (§4.2).
- `enableSessionForAPIKeys: false` written explicitly as a tripwire; `enableMetadata: false`; the grant lives in **`permissions`**, zod-parsed **on every read, fail-closed to deny** (§5.2).
- The plugin's client-facing `/api/auth/api-key/*` routes are **404**; keys are minted only by our own path (§5.2). The five routes: `create`, `get`, `list`, `update`, `delete` (spike 5).
- `role` is a better-auth `additionalFields` entry with **`input: false`** (§5.3).
- `bodyLimit` 4 MB; per-call deadline `AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(MCP_CALL_TIMEOUT_MS)])` (§4.2).
- No token in the query string; every request carries `Authorization: Bearer` (§5.1).

## Rulings (plan vs. design vs. spec)

- **R1 — the `'session'` ban vs. the generated `session` table.** §6 puts the better-auth tables in `packages/core/src/db/schema/auth.ts`; the P0 constraint bans the string in core. The ban exists so core never grows a session→scope map; a *table name* in generated DDL is not that. The generated file is the one exemption, checked by `grep -rn session packages/core/src --exclude=auth.ts` returning nothing. Cost if wrong: a reviewer disagrees and the tables move to `packages/server/src/db/auth-schema.ts` with a second drizzle schema path — one config line.
- **R2 — no human login in P1c.** `emailAndPassword` is off. Sign-up over HTTP would let a stranger become the first user of a fresh public hub; §6's bootstrap-token claim belongs with the console (P3) that consumes a human session. Users and keys are created by the CLI, which already holds `DATABASE_URL` and the keyring — it is operator-level by construction. Cost if wrong: P3 turns `emailAndPassword` on and adds the bootstrap claim; nothing here changes.
- **R3 — keys are minted by the CLI, not `POST /api/keys`.** §5.2's `POST /api/keys` exists to enforce "requested grant ⊆ creator's reach". In P1 the only grant is `{mcp:['all']}` and the only minter is an operator with database credentials, so there is nothing to intersect. `POST /api/keys` lands in P2 with groups and the subset check. The plugin's own routes are 404 from day one either way.
- **R4 — the P1 grant is exactly `{ mcp: ['all'] }`.** Anything else — missing, `['read']`, extra entries — denies. P2 widens the zod schema; old keys keep working because `['all']` stays valid.
- **R5 — no `owner_id` on `servers`.** P1b's R6 anticipated it; §5.3 (owner decision, 2026-09-19) says servers are team-shared, **no `owner_id`, no `visibility`**. Only the `secrets.user_id → user.id` FK arrives here.
- **R6 — only `{kind:'all'}` in P1c.** `/mcp/g/:group`, `/mcp/s/:server`, `/mcp/smart*` answer the `/mcp/*` 404 until P2/P5. `/.well-known/oauth-*` stays 404 (the SPA fallback's reserved list) until the OAuth plugin phase.
- **R7 — deferred §4.2 limits:** per-principal concurrency semaphore (429) and the 1 MB result cap arrive with P2's guardrails ("cap response upstream" is on P2's list). `bodyLimit` and the per-call deadline ship now — both are one line.
- **R8 — the Engine follows the table by polling a fingerprint** (`md5` over `id‖updated_at`) every 5 s instead of LISTEN/NOTIFY: no long-lived connection to re-establish, correct across replicas, 5 s staleness is fine for an operator adding a server. Marked with a `ponytail:` comment naming the upgrade.
- **R9 — the CLI is not in the Docker image yet.** The image deploys `@mcprouter/server` only; operators run the CLI from a checkout against the database (compose publishes 5432). Packaging the CLI into the image is a Dockerfile change for P3's release work.
- **R10 — better-auth's logger goes to pino at `debug`.** It logs every invalid key at ERROR (spike 5); invalid keys are ordinary internet traffic and must not page anyone.

## Review Focus

1. **An admin's API key** → `isAdmin: false`, always. Pinned in Task 2 (`an admin's key is not admin`).
2. **A key whose `permissions` were edited in the database to something P1 does not know** (`{"mcp":["admin"]}`, `null`, malformed JSON) → 401, never a partial grant. Pinned in Task 2.
3. **GET `/mcp` from a client that tries the SSE stream first** → an immediate 405 with `Allow: POST`, never a hanging 200 `text/event-stream` (spike 4). Pinned in Task 4.
4. **Two consecutive requests from one client** (`initialize`, then `notifications/initialized`, then `tools/list`) → all succeed; a shared transport would 500 on the second (spike 4). Pinned in Task 3 by the real SDK client.
5. **A server added while the hub runs** → appears within one poll; a server whose secret cannot be opened is logged with its slug and left out while the others keep serving. Pinned in Task 5.

---

## File Structure

| file | responsibility |
| ---- | -------------- |
| `packages/core/src/db/schema/auth.ts` | better-auth tables, generated by `auth generate` (do not hand-edit) |
| `packages/server/src/auth.ts` | `createAuth` (better-auth as configuration) and `authenticateKey` (bearer → `Principal`) |
| `packages/server/src/mcp/legacy.ts` | the era adapter: per-request `Server` + stateless transport → `Engine` |
| `packages/server/src/app.ts` | `/mcp` routes, 405/404, `bodyLimit`, `/api/auth/*` mount with the 5 routes darkened |
| `packages/server/src/servers-sync.ts` | fingerprint poll → `loadServerConfigs` → `Engine.applyConfig`; the `{kind:'all'}` scope |
| `packages/server/src/main.ts` | wiring |
| `packages/cli/src/commands.ts` | `secret`, `users add`, `keys create`, `servers add` as testable functions |
| `packages/cli/src/main.ts` | argv dispatch |

---

### Task 1: better-auth tables and the `secrets.user_id` FK

**Files:**
- Create: `packages/core/src/db/schema/auth.ts`
- Modify: `packages/core/src/db/schema/index.ts`, `packages/core/src/db/schema/secrets.ts`
- Create: `drizzle/0003_*.sql` (generated)
- Test: `packages/core/src/db/auth-schema.itest.ts`

**Interfaces:**
- Consumes: `secrets`, `servers` (P1b).
- Produces: tables `user` (with `role text not null default 'viewer'`), `session`, `account`, `verification`, `apikey`, all exported from `schema/index.ts` and present in `schema` under exactly those keys (the drizzle adapter looks them up by model name). `secrets.user_id` references `user.id` `ON DELETE CASCADE`.

- [ ] **Step 1: Write the failing integration test**

`packages/core/src/db/auth-schema.itest.ts`:

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

async function addUser(): Promise<string> {
  const id = randomUUID();
  await pool.query('insert into "user" (id, name, email) values ($1, $2, $3)', [id, 'U', `${id}@x.io`]);
  return id;
}

function addSecret(userId: string | null) {
  return pool.query(
    `insert into secrets (id, scope, user_id, label, key_version, iv, ciphertext, tag)
     values ($1, 'credential', $2, 'K', 1, $3, $4, $5)`,
    [randomUUID(), userId, Buffer.alloc(12), Buffer.alloc(8), Buffer.alloc(16)],
  );
}

describe('better-auth tables', () => {
  it.each(['user', 'session', 'account', 'verification', 'apikey'])('creates %s', async (t) => {
    const r = await pool.query('select 1 from information_schema.tables where table_name = $1', [t]);
    expect(r.rowCount).toBe(1);
  });

  it('defaults a new user to the viewer role', async () => {
    const id = await addUser();
    const r = await pool.query('select role from "user" where id = $1', [id]);
    expect(r.rows[0].role).toBe('viewer');
  });
});

describe('secrets.user_id', () => {
  it('rejects a secret for a user that does not exist', async () => {
    await expect(addSecret('nobody')).rejects.toEqual(expect.objectContaining({ code: '23503' }));
  });

  it('goes away with its user', async () => {
    const id = await addUser();
    await addSecret(id);
    await pool.query('delete from "user" where id = $1', [id]);
    const left = await pool.query('select 1 from secrets where user_id = $1', [id]);
    expect(left.rowCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project integration packages/core/src/db/auth-schema.itest.ts`
Expected: FAIL — `relation "user" does not exist` / 0 rows for the table checks.

- [ ] **Step 3: Add the generated schema**

`packages/core/src/db/schema/auth.ts` — output of `auth@1.7.5 generate` for the Task 2 configuration (email/password off, `role` additional field, `apiKey` plugin). Header comment, then the generated body verbatim (prettier reformats quotes; that is fine):

```ts
// Generated by `pnpm dlx auth@1.7.5 generate` from packages/server/src/auth.ts.
// Do not hand-edit: regenerate when the better-auth config or version changes.
import { relations } from 'drizzle-orm';
import { pgTable, text, timestamp, boolean, integer, index } from 'drizzle-orm/pg-core';

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  role: text('role').default('viewer').notNull(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_userId_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('account_userId_idx').on(table.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

export const apikey = pgTable(
  'apikey',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').default('default').notNull(),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id').notNull(),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: timestamp('last_refill_at'),
    enabled: boolean('enabled').default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window').default(86400000),
    rateLimitMax: integer('rate_limit_max').default(10),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: timestamp('last_request'),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (table) => [
    index('apikey_configId_idx').on(table.configId),
    index('apikey_referenceId_idx').on(table.referenceId),
    index('apikey_key_idx').on(table.key),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));
```

`packages/core/src/db/schema/index.ts` — import and re-export the five tables, add them to `schema`:

```ts
import { account, apikey, session, user, verification } from './auth.js';

export { account, apikey, session, user, verification };

export const schema = {
  systemSetting,
  servers,
  secrets,
  user,
  session,
  account,
  verification,
  apikey,
};
```

`packages/core/src/db/schema/secrets.ts` — import `user` from `./auth.js`, replace the `userId` column and add an index:

```ts
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
```

```ts
    index('secrets_user_idx').on(t.userId),
```

(delete the "FK to better-auth's "user" arrives with that table in P1c." comment.)

- [ ] **Step 4: Generate the migration and run the test**

Run: `pnpm build && pnpm db:generate`
Expected: `drizzle/0003_<name>.sql` with five `CREATE TABLE`s, `secrets_user_id_user_id_fk … ON DELETE cascade`, `secrets_user_idx`.

Run: `pnpm vitest run --project integration packages/core/src/db`
Expected: PASS (auth-schema, schema, store, migrate).

- [ ] **Step 5: Gates and commit**

Run: `pnpm lint && pnpm test && grep -rn session packages/core/src --exclude=auth.ts`
Expected: exit 0; the grep prints nothing (R1).

```bash
git add packages/core drizzle
git commit -m "feat(core): better-auth tables; secrets.user_id references user"
pnpm db:check
```

Expected: `db:check OK`.

---

### Task 2: better-auth as configuration, and bearer → `Principal`

**Files:**
- Modify: `packages/server/package.json` (dependencies)
- Create: `packages/server/src/auth.ts`
- Test: `packages/server/src/auth.itest.ts`

**Interfaces:**
- Consumes: `schema`, `type Db`, `type Principal` from `@mcprouter/core`.
- Produces:
  - `createAuth(deps: { db: Db; secret: string; baseURL: string; log: Logger }): Auth` (the `betterAuth` instance)
  - `type Auth = ReturnType<typeof createAuth>`
  - `authenticateKey(auth: Auth, authorization: string | undefined): Promise<Principal | null>`
  - `KEY_GRANT_ALL = { mcp: ['all'] }` — the only grant P1 mints

- [ ] **Step 1: Add dependencies**

In `packages/server/package.json` `dependencies` add (alphabetical):

```json
    "@better-auth/api-key": "1.7.5",
    "@better-auth/core": "1.7.5",
    "@better-auth/utils": "0.4.2",
    "@modelcontextprotocol/sdk": "1.30.0",
    "better-auth": "1.7.5",
    "better-call": "1.4.0",
    "drizzle-orm": "0.45.2",
```

Run: `pnpm install`
Expected: exit 0, lockfile updated. (`better-call`, `@better-auth/core`, `@better-auth/utils` are peers of the api-key package; declaring them keeps pnpm's strict linker happy.)

- [ ] **Step 2: Write the failing integration test**

`packages/server/src/auth.itest.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import type { Pool } from 'pg';
import { createDb, createPool, runMigrations, schema } from '@mcprouter/core';
import { authenticateKey, createAuth, KEY_GRANT_ALL, type Auth } from './auth.js';

const log = pino({ level: 'silent' });
let pg: StartedPostgreSqlContainer;
let pool: Pool;
let auth: Auth;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = createPool(pg.getConnectionUri());
  await runMigrations(pool, log);
  auth = createAuth({ db: createDb(pool), secret: 'k'.repeat(32), baseURL: 'http://hub.test', log });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
});

async function user(role: string): Promise<string> {
  const id = randomUUID();
  await createDb(pool).insert(schema.user).values({ id, name: role, email: `${id}@x.io`, role });
  return id;
}

async function mint(userId: string, permissions?: Record<string, string[]>): Promise<string> {
  const k = await auth.api.createApiKey({
    body: { name: 't', userId, ...(permissions === undefined ? {} : { permissions }) },
  });
  return k.key;
}

describe('authenticateKey', () => {
  it('turns a valid bearer key into its owner', async () => {
    const id = await user('operator');
    const key = await mint(id, KEY_GRANT_ALL);
    expect(key.startsWith('mcpr_')).toBe(true);
    expect(await authenticateKey(auth, `Bearer ${key}`)).toEqual({ id, isAdmin: false });
    expect(await authenticateKey(auth, `bearer ${key}`)).toEqual({ id, isAdmin: false });
  });

  it("an admin's key is not admin", async () => {
    const key = await mint(await user('admin'), KEY_GRANT_ALL);
    expect((await authenticateKey(auth, `Bearer ${key}`))?.isAdmin).toBe(false);
  });

  it.each([
    ['no header', undefined],
    ['empty', ''],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['an unknown key', 'Bearer mcpr_doesnotexist'],
    ['a bare key', 'mcpr_abc'],
  ])('rejects %s', async (_n, header) => {
    expect(await authenticateKey(auth, header)).toBeNull();
  });

  it('rejects a key minted without the P1 grant', async () => {
    const id = await user('operator');
    expect(await authenticateKey(auth, `Bearer ${await mint(id)}`)).toBeNull();
    expect(await authenticateKey(auth, `Bearer ${await mint(id, { mcp: ['read'] })}`)).toBeNull();
  });

  it.each([
    ['an unknown grant', '{"mcp":["admin"]}'],
    ['a widened grant', '{"mcp":["all","admin"]}'],
    ['null', null],
    ['malformed JSON', '{mcp'],
  ])('fails closed on permissions edited to %s', async (_n, raw) => {
    const key = await mint(await user('operator'), KEY_GRANT_ALL);
    await pool.query('update apikey set permissions = $1 where key = (select key from apikey order by created_at desc limit 1)', [raw]);
    expect(await authenticateKey(auth, `Bearer ${key}`)).toBeNull();
  });

  it('rejects a disabled or expired key', async () => {
    const id = await user('operator');
    const off = await mint(id, KEY_GRANT_ALL);
    await pool.query(`update apikey set enabled = false where start = $1`, [off.slice(0, 6)]);
    expect(await authenticateKey(auth, `Bearer ${off}`)).toBeNull();

    const old = await mint(id, KEY_GRANT_ALL);
    await pool.query(`update apikey set expires_at = now() - interval '1 minute' where start = $1`, [
      old.slice(0, 6),
    ]);
    expect(await authenticateKey(auth, `Bearer ${old}`)).toBeNull();
  });
});
```

Note on the `start`-based updates: `start` is only the first 6 characters (`mcpr_` + 1), so two keys can collide. Where a test needs one specific row, it updates `order by created_at desc limit 1` instead; the disabled/expired test mints and updates one key at a time, so the most recent row is the one just minted — **change those two updates to the `order by created_at desc limit 1` form** if a collision ever shows up.

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run --project integration packages/server/src/auth.itest.ts`
Expected: FAIL — cannot resolve `./auth.js`.

- [ ] **Step 4: Implement**

`packages/server/src/auth.ts`:

```ts
import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { Logger } from 'pino';
import { z } from 'zod';
import { schema, type Db, type Principal } from '@mcprouter/core';

/** The only grant P1 mints. P2 widens `Grant` to groups/servers. */
export const KEY_GRANT_ALL = { mcp: ['all'] };

/** Parsed on every read and fail-closed (§5.2): anything P1 does not know denies. */
const Grant = z.strictObject({ mcp: z.tuple([z.literal('all')]) });

export type AuthDeps = { db: Db; secret: string; baseURL: string; log: Logger };

/** better-auth is configuration, not code (§13 P1). We store, hash and look up nothing ourselves. */
export function createAuth({ db, secret, baseURL, log }: AuthDeps) {
  return betterAuth({
    secret,
    baseURL,
    basePath: '/api/auth',
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    // Humans sign in with the console (P3). Until then users are created by the CLI.
    emailAndPassword: { enabled: false },
    user: {
      additionalFields: {
        // input:false — otherwise a sign-up payload could set role:'admin' (§5.3).
        role: { type: 'string', input: false, defaultValue: 'viewer', required: true },
      },
    },
    // Invalid keys are ordinary traffic and better-auth logs each one at ERROR.
    logger: { log: (level, message) => log.debug({ evt: 'auth.lib', level }, message) },
    plugins: [
      apiKey({
        // §5.2 tripwire. true would mint a session for every key, and an admin's key would be admin.
        enableSessionForAPIKeys: false,
        // The key's owner can write metadata over HTTP; the grant lives in server-only `permissions`.
        enableMetadata: false,
        // The default is 10 requests per DAY.
        rateLimit: { enabled: false },
        defaultPrefix: 'mcpr_',
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const BEARER = /^Bearer\s+(\S+)$/i;

export async function authenticateKey(
  auth: Auth,
  authorization: string | undefined,
): Promise<Principal | null> {
  const key = BEARER.exec(authorization ?? '')?.[1];
  if (key === undefined) return null;
  // Returns {valid:false}, never throws, for an unknown/disabled/expired key.
  const r = await auth.api.verifyApiKey({ body: { key } });
  if (!r.valid || r.key === null) return null;
  if (!Grant.safeParse(r.key.permissions).success) return null;
  // §5.2: a machine credential is never admin, whatever its owner's role.
  return { id: r.key.referenceId, isAdmin: false };
}
```

If `tsc` rejects the `logger.log` signature or `r.key.permissions`' type, adjust to the installed `.d.ts` (e.g. `(level: string, message: string) => …`) and note it as a ruling; the behavior is what the test pins.

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm build && pnpm vitest run --project integration packages/server/src/auth.itest.ts`
Expected: PASS. If "malformed JSON" throws inside `verifyApiKey` instead of returning invalid, wrap the call in `try { … } catch { return null; }` — fail closed — and ledger it.

- [ ] **Step 6: Gates and commit**

Run: `pnpm lint && pnpm test`

```bash
git add packages/server pnpm-lock.yaml
git commit -m "feat(server): better-auth + apiKey as configuration; bearer keys are never admin"
```

---

### Task 3: The era adapter — `mcp/legacy.ts`

**Files:**
- Create: `packages/server/src/mcp/legacy.ts`
- Test: `packages/server/src/mcp/legacy.test.ts`

**Interfaces:**
- Consumes: `Engine`, `ToolUnavailableError`, `VERSION`, `type Principal`, `type ResolvedScope` from `@mcprouter/core`; test-only `FakeUpstream`, `fakeFactory` from `packages/core/test/fake-upstream.ts`.
- Produces:
  - `type McpCall = { engine: Engine; scope: ResolvedScope; principal: Principal; timeoutMs: number }`
  - `handleMcp(req: Request, call: McpCall): Promise<Response>`

- [ ] **Step 1: Write the failing test**

`packages/server/src/mcp/legacy.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Engine, type Principal, type ResolvedScope } from '@mcprouter/core';
import { FakeUpstream, fakeFactory } from '../../../core/test/fake-upstream.js';
import { handleMcp, type McpCall } from './legacy.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const principal: Principal = { id: 'u1', isAdmin: false };
const scope: ResolvedScope = {
  key: 'fs',
  servers: [{ serverName: 'fs', tools: 'all', prompts: 'all', resources: 'all' }],
  flatten: false,
};
let engine: Engine;

beforeAll(async () => {
  const fs = new FakeUpstream(
    'fs',
    [
      { name: 'echo', handler: (a) => `echo:${String(a['text'])}` },
      {
        name: 'boom',
        handler: () => {
          throw new Error('upstream exploded');
        },
      },
      { name: 'slow', handler: () => new Promise((r) => setTimeout(() => r('late'), 2_000)) },
    ],
    {
      prompts: [{ name: 'greet', handler: (a) => `hi ${a['who']}` }],
      resources: [{ uri: 'mem://readme', handler: () => 'readme body' }],
    },
  );
  engine = new Engine({ logger, connect: fakeFactory({ fs }) });
  await engine.applyConfig([
    { name: 'fs', enabled: true, credentialMode: 'shared', type: 'stdio', command: 'x' },
  ]);
  await vi.waitFor(() => expect(engine.status()[0]?.state).toBe('ready'));
});

afterAll(() => engine.shutdown());

const call = (timeoutMs = 5_000): McpCall => ({ engine, scope, principal, timeoutMs });

async function client(timeoutMs?: number): Promise<Client> {
  const c = new Client({ name: 'test', version: '0.0.0' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL('http://hub.test/mcp'), {
      fetch: (url, init) => handleMcp(new Request(url, init), call(timeoutMs)),
    }),
  );
  return c;
}

describe('handleMcp', () => {
  it('serves initialize, initialized and tools/list as separate requests', async () => {
    const c = await client();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['fs__boom', 'fs__echo', 'fs__slow']);
    await c.close();
  });

  it('calls a tool through the engine', async () => {
    const c = await client();
    const res = await c.callTool({ name: 'fs__echo', arguments: { text: 'hi' } });
    expect(JSON.stringify(res.content)).toContain('echo:hi');
    await c.close();
  });

  it('an unknown tool is a protocol error with the one not-found message', async () => {
    const c = await client();
    await expect(c.callTool({ name: 'fs__nope', arguments: {} })).rejects.toThrow(
      /Tool not found: fs__nope/,
    );
    await c.close();
  });

  it('an upstream failure is a tool result with isError, not a transport failure', async () => {
    const c = await client();
    const res = await c.callTool({ name: 'fs__boom', arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('upstream exploded');
    await c.close();
  });

  it('a call past the deadline comes back as an error result', async () => {
    const c = await client(100);
    const res = await c.callTool({ name: 'fs__slow', arguments: {} });
    expect(res.isError).toBe(true);
    await c.close();
  });

  it('serves prompts and resources', async () => {
    const c = await client();
    const { prompts } = await c.listPrompts();
    const greet = prompts.find((p) => p.name.endsWith('greet'));
    expect(greet).toBeDefined();
    const got = await c.getPrompt({ name: greet?.name ?? '', arguments: { who: 'bob' } });
    expect(JSON.stringify(got.messages)).toContain('hi bob');

    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri)).toEqual(['mem://readme']);
    const read = await c.readResource({ uri: 'mem://readme' });
    expect(JSON.stringify(read.contents)).toContain('readme body');
    await c.close();
  });

  it('answers with buffered JSON, no session id, and X-Accel-Buffering: no', async () => {
    const res = await handleMcp(
      new Request('http://hub.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 't', version: '0' },
          },
        }),
      }),
      call(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(res.headers.get('x-accel-buffering')).toBe('no');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/server/src/mcp/legacy.test.ts`
Expected: FAIL — cannot resolve `./legacy.js`.

- [ ] **Step 3: Implement**

`packages/server/src/mcp/legacy.ts`:

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
  type GetPromptResult,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ToolUnavailableError,
  VERSION,
  type Engine,
  type Principal,
  type ResolvedScope,
} from '@mcprouter/core';

export type McpCall = {
  engine: Engine;
  scope: ResolvedScope;
  principal: Principal;
  timeoutMs: number;
};

/** Hidden, missing and disabled are one protocol error with core's one message. */
function notFound(err: unknown): never {
  if (err instanceof ToolUnavailableError) throw new McpError(ErrorCode.InvalidParams, err.message);
  throw err;
}

/**
 * The era adapter (§4.2): everything specific to legacy-era, stateless
 * Streamable HTTP lives in this file. A stateless transport serves exactly ONE
 * request, and `notifications/initialized` is already a second one — so the
 * Server and the transport are both built per request (spike 4).
 */
export async function handleMcp(req: Request, call: McpCall): Promise<Response> {
  const { engine, scope, principal } = call;
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(call.timeoutMs)]);

  const server = new Server(
    { name: 'mcprouter', version: VERSION },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await engine.listTools(scope, principal),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    try {
      return (await engine.callTool({
        scope,
        principal,
        name: r.params.name,
        args: r.params.arguments ?? {},
        signal,
      })) as CallToolResult;
    } catch (err) {
      if (err instanceof ToolUnavailableError) notFound(err);
      // An upstream failure is the tool's result, not the gateway's: the model sees it.
      const text = err instanceof Error ? err.message : 'tool call failed';
      return { content: [{ type: 'text', text }], isError: true };
    }
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: await engine.listPrompts(scope, principal),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (r) => {
    try {
      return (await engine.getPrompt({
        scope,
        principal,
        name: r.params.name,
        args: r.params.arguments ?? {},
        signal,
      })) as GetPromptResult;
    } catch (err) {
      return notFound(err);
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: await engine.listResources(scope, principal),
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: await engine.listResourceTemplates(scope, principal),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (r) => {
    try {
      return (await engine.readResource({
        scope,
        principal,
        uri: r.params.uri,
        signal,
      })) as ReadResourceResult;
    } catch (err) {
      return notFound(err);
    }
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // The only mode whose Response is fully buffered, so closing below cannot truncate it.
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req);
    const headers = new Headers(res.headers);
    headers.set('X-Accel-Buffering', 'no');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } finally {
    await transport.close();
    await server.close();
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm build && pnpm vitest run packages/server/src/mcp/legacy.test.ts`
Expected: PASS. If a readResource/getPrompt of an unknown name surfaces a different core error class than `ToolUnavailableError`, extend `notFound`'s `instanceof` to it and ledger the class name.

- [ ] **Step 5: Gates and commit**

Run: `pnpm lint && pnpm test`

```bash
git add packages/server/src/mcp
git commit -m "feat(server): stateless Streamable HTTP era adapter over the Engine"
```

---

### Task 4: The `/mcp` routes, 405/404 and `/api/auth/*`

**Files:**
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/src/app.mcp.test.ts`

**Interfaces:**
- Consumes: `handleMcp` (Task 3); `Engine`, `currentContext`, `type Principal`, `type ResolvedScope` from `@mcprouter/core`.
- Produces:
  - `interface McpDeps { authenticate(authorization: string | undefined): Promise<Principal | null>; engine: Engine; scopeAll(): ResolvedScope; timeoutMs: number; authHandler(req: Request): Promise<Response> }`
  - `AppDeps.mcp?: McpDeps` — absent means the routes are not mounted (the P0 app tests keep working untouched)
  - `API_KEY_ROUTES: readonly string[]`

- [ ] **Step 1: Write the failing test**

`packages/server/src/app.mcp.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Engine, type Principal, type ResolvedScope } from '@mcprouter/core';
import { FakeUpstream, fakeFactory } from '../../core/test/fake-upstream.js';
import { API_KEY_ROUTES, createApp } from './app.js';
import { parseConfig } from './config.js';
import { createRegistry } from './metrics.js';

const principal: Principal = { id: 'u1', isAdmin: false };
const scope: ResolvedScope = {
  key: 'all:fs',
  servers: [{ serverName: 'fs', tools: 'all', prompts: 'all', resources: 'all' }],
  flatten: false,
};
let engine: Engine;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  engine = new Engine({
    logger,
    connect: fakeFactory({ fs: new FakeUpstream('fs', [{ name: 'echo', handler: () => 'ok' }]) }),
  });
  await engine.applyConfig([
    { name: 'fs', enabled: true, credentialMode: 'shared', type: 'stdio', command: 'x' },
  ]);
  await vi.waitFor(() => expect(engine.status()[0]?.state).toBe('ready'));

  const r = parseConfig({
    DATABASE_URL: 'postgres://u:p@localhost:5432/d',
    AUTH_SECRET: 'z'.repeat(32),
    PUBLIC_URL: 'http://localhost:3000',
    MCPR_SECRET_KEYS: `v1:${Buffer.alloc(32, 3).toString('base64url')}`,
  });
  if (!r.ok) throw new Error(r.issues.join(','));
  app = createApp({
    config: r.config,
    log: pino({ level: 'silent' }),
    pool: {} as pg.Pool,
    registry: createRegistry(),
    readiness: { migrationsApplied: true, routesMounted: true },
    mcp: {
      authenticate: async (h) => (h === 'Bearer good' ? principal : null),
      engine,
      scopeAll: () => scope,
      timeoutMs: 5_000,
      authHandler: async () => new Response('from-better-auth'),
    },
  });
});

afterAll(() => engine.shutdown());

const KEY = { authorization: 'Bearer good' };

describe('/mcp', () => {
  it('401s without a key, with WWW-Authenticate: Bearer', async () => {
    const res = await app.request('/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('401s a bad key, and a GET without a key', async () => {
    expect((await app.request('/mcp', { method: 'POST', headers: { authorization: 'Bearer bad' } })).status).toBe(401);
    expect((await app.request('/mcp')).status).toBe(401);
  });

  it.each([
    ['GET', '/mcp'],
    ['DELETE', '/mcp'],
    ['GET', '/mcp/s/fs'],
    ['DELETE', '/mcp/g/team'],
    ['PUT', '/mcp'],
  ])('%s %s → 405 Allow: POST, never an open stream', async (method, path) => {
    const res = await app.request(path, { method, headers: KEY });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(res.headers.get('content-type')).not.toContain('text/event-stream');
  });

  it.each(['/mcp/nope', '/mcp/g/team', '/mcp/s/fs', '/mcp/smart'])(
    'POST %s → 404 not_found until its phase',
    async (path) => {
      const res = await app.request(path, { method: 'POST', headers: KEY, body: '{}' });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    },
  );

  it('refuses a body over 4 MB', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { ...KEY, 'content-type': 'application/json' },
      body: 'x'.repeat(4 * 1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });

  it('a real MCP client lists and calls through POST /mcp', async () => {
    const c = new Client({ name: 'test', version: '0.0.0' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        requestInit: { headers: KEY },
        fetch: (url, init) => app.request(String(url), init),
      }),
    );
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['fs__echo']);
    const res = await c.callTool({ name: 'fs__echo', arguments: {} });
    expect(JSON.stringify(res.content)).toContain('ok');
    await c.close();
  });
});

describe('/api/auth', () => {
  it.each(API_KEY_ROUTES)('darkens the plugin route %s', async (path) => {
    const res = await app.request(path, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('forwards everything else to better-auth', async () => {
    const res = await app.request('/api/auth/ok');
    expect(await res.text()).toBe('from-better-auth');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/server/src/app.mcp.test.ts`
Expected: FAIL — `API_KEY_ROUTES` is not exported / `mcp` is not an `AppDeps` field.

- [ ] **Step 3: Implement**

`packages/server/src/app.ts`:

- imports: add `import type { Context } from 'hono';`, `import { bodyLimit } from 'hono/body-limit';`, extend the core import to `import { currentContext, newRequestId, runWithContext, type Engine, type Principal, type ResolvedScope } from '@mcprouter/core';`, and `import { handleMcp } from './mcp/legacy.js';`
- after `AppDeps`:

```ts
export interface McpDeps {
  /** `Authorization` header → machine principal, or null. */
  authenticate: (authorization: string | undefined) => Promise<Principal | null>;
  engine: Engine;
  /** The `{kind:'all'}` target (§4.2): every enabled server currently loaded. */
  scopeAll: () => ResolvedScope;
  timeoutMs: number;
  /** better-auth's fetch handler. */
  authHandler: (req: Request) => Promise<Response>;
}

/** §5.2: the plugin's client-facing routes. Keys are minted only by our own path. */
export const API_KEY_ROUTES = ['create', 'get', 'list', 'update', 'delete'].map(
  (r) => `/api/auth/api-key/${r}`,
);
```

- `AppDeps` gains `mcp?: McpDeps | undefined;`
- `KNOWN_ROUTES` gains `'/mcp'`
- in `createApp`, **before** the `if (deps.webRoot !== undefined)` block:

```ts
  if (deps.mcp !== undefined) mountMcp(app, deps.mcp);
```

- new function below `createApp`:

```ts
function mountMcp(app: Hono, mcp: McpDeps): void {
  const limit = bodyLimit({
    maxSize: 4 * 1024 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  });
  app.use('/mcp', limit);
  app.use('/mcp/*', limit);

  // Every /mcp route is bearer-authenticated, the 405s and 404s included (§4.2).
  const guarded =
    (handler: (c: Context, p: Principal) => Response | Promise<Response>) =>
    async (c: Context): Promise<Response> => {
      const principal = await mcp.authenticate(c.req.header('authorization'));
      if (principal === null) {
        return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
      }
      const ctx = currentContext();
      if (ctx !== undefined) ctx.principal = principal.id;
      return handler(c, principal);
    };

  // A stateless transport answers GET with a 200 event stream that never ends (spike 4).
  const notAllowed = (c: Context): Response =>
    c.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
      405,
      { Allow: 'POST' },
    );

  app.post(
    '/mcp',
    guarded((c, principal) =>
      handleMcp(c.req.raw, {
        engine: mcp.engine,
        scope: mcp.scopeAll(),
        principal,
        timeoutMs: mcp.timeoutMs,
      }),
    ),
  );
  app.on(['GET', 'DELETE'], ['/mcp', '/mcp/*'], guarded(notAllowed));
  app.all('/mcp/*', guarded((c) => c.json({ error: 'not_found' }, 404)));
  app.all('/mcp', guarded(notAllowed));

  for (const path of API_KEY_ROUTES) app.all(path, (c) => c.json({ error: 'not_found' }, 404));
  app.on(['GET', 'POST'], '/api/auth/*', (c) => mcp.authHandler(c.req.raw));
}
```

Hono's `/mcp/*` also matches `/mcp`; registration order above (POST `/mcp` first, then GET/DELETE, then the catch-alls) is what makes POST `/mcp` reach the transport. The test pins it.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm build && pnpm vitest run packages/server`
Expected: PASS — the new file and the unchanged P0 `app.test.ts`.

- [ ] **Step 5: Gates and commit**

Run: `pnpm lint && pnpm test`

```bash
git add packages/server/src/app.ts packages/server/src/app.mcp.test.ts
git commit -m "feat(server): POST /mcp behind bearer keys; 405 for GET/DELETE; plugin key routes dark"
```

---

### Task 5: Keep the Engine in step with the table, and wire the process

**Files:**
- Modify: `packages/server/src/config.ts`, `packages/server/src/config.test.ts`
- Create: `packages/server/src/servers-sync.ts`
- Test: `packages/server/src/servers-sync.itest.ts`
- Modify: `packages/server/src/main.ts`, `packages/server/src/index.ts`

**Interfaces:**
- Consumes: `loadServerConfigs`, `Engine`, `type Keyring`, `type Db` (core); `createAuth`, `authenticateKey` (Task 2); `createApp` (Task 4).
- Produces:
  - `Config.mcpCallTimeoutMs: number` (`MCP_CALL_TIMEOUT_MS`, default 60000, min 1000)
  - `type ServerSync = { scopeAll(): ResolvedScope; refresh(): Promise<void>; stop(): void }`
  - `EMPTY_SCOPE: ResolvedScope`
  - `startServerSync(o: { pool: pg.Pool; db: Db; keyring: Keyring; engine: Engine; log: Logger; intervalMs?: number }): Promise<ServerSync>`
  - `@mcprouter/server` exports `createAuth`, `type Auth`, `loadConfig`, `parseConfig`, `type Config`, `createApp`, `createRegistry`, `startServerSync`, `authenticateKey` (the CLI and the demo test use them)

- [ ] **Step 1: Write the failing tests**

In `packages/server/src/config.test.ts`, inside `describe('parseConfig', …)`:

```ts
  it('defaults MCP_CALL_TIMEOUT_MS to 60 s and accepts an override', () => {
    const d = parseConfig(valid);
    expect(d.ok && d.config.mcpCallTimeoutMs).toBe(60_000);
    const o = parseConfig({ ...valid, MCP_CALL_TIMEOUT_MS: '5000' });
    expect(o.ok && o.config.mcpCallTimeoutMs).toBe(5_000);
    expect(parseConfig({ ...valid, MCP_CALL_TIMEOUT_MS: '10' }).ok).toBe(false);
  });
```

`packages/server/src/servers-sync.itest.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino, type Logger } from 'pino';
import type { Pool } from 'pg';
import {
  createDb,
  createPool,
  createServer,
  Engine,
  parseKeyring,
  runMigrations,
  type Db,
} from '@mcprouter/core';
import { FakeUpstream, fakeFactory } from '../../core/test/fake-upstream.js';
import { startServerSync, type ServerSync } from './servers-sync.js';

const kr = parseKeyring(`v1:${Buffer.alloc(32, 1).toString('base64url')}`);
const stdio = (env: Record<string, string> = {}) => ({ type: 'stdio' as const, command: 'x', env });
const names = (s: ServerSync) => s.scopeAll().servers.map((x) => x.serverName);

let pg: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let engine: Engine;
let sync: ServerSync;
const errors: unknown[] = [];

beforeAll(async () => {
  pg = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = createPool(pg.getConnectionUri());
  await runMigrations(pool, pino({ level: 'silent' }));
  db = createDb(pool);
  engine = new Engine({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    connect: fakeFactory({
      fs: new FakeUpstream('fs', [{ name: 't' }]),
      gh: new FakeUpstream('gh', [{ name: 't' }]),
      off: new FakeUpstream('off', [{ name: 't' }]),
    }),
  });
  const log = pino({ level: 'silent' });
  log.error = ((o: unknown) => void errors.push(o)) as Logger['error'];
  await createServer(db, kr, { slug: 'fs', config: stdio() });
  sync = await startServerSync({ pool, db, keyring: kr, engine, log, intervalMs: 50 });
}, 120_000);

afterAll(async () => {
  sync?.stop();
  await engine?.shutdown();
  await pool?.end();
  await pg?.stop();
});

describe('startServerSync', () => {
  it('applies the table before it resolves', () => {
    expect(names(sync)).toEqual(['fs']);
    expect(engine.status().map((s) => s.name)).toEqual(['fs']);
    expect(sync.scopeAll().flatten).toBe(false);
  });

  it('picks up a server added while it runs', async () => {
    await createServer(db, kr, { slug: 'gh', config: stdio() });
    await vi.waitFor(() => expect(names(sync)).toEqual(['fs', 'gh']));
  });

  it('keeps a disabled server out of the scope', async () => {
    await createServer(db, kr, { slug: 'off', enabled: false, config: stdio() });
    await vi.waitFor(() => expect(engine.status().map((s) => s.name)).toContain('off'));
    expect(names(sync)).not.toContain('off');
  });

  it('drops a deleted server', async () => {
    await pool.query(`delete from servers where slug = 'gh'`);
    await vi.waitFor(() => expect(names(sync)).toEqual(['fs']));
    expect(engine.status().map((s) => s.name)).not.toContain('gh');
  });

  it('logs a server whose secret cannot be opened, by slug, and keeps serving the rest', async () => {
    await createServer(db, kr, { slug: 'broken', config: stdio({ K: 'v' }) });
    await pool.query(`update secrets set tag = decode(repeat('00', 16), 'hex') where label = 'K'`);
    await pool.query(`update servers set updated_at = now() where slug = 'broken'`);
    await vi.waitFor(() =>
      expect(errors).toContainEqual(expect.objectContaining({ server: 'broken' })),
    );
    expect(names(sync)).toEqual(['fs']);
  });
});
```

(The 'broken' row: `createServer` inserts it and the poll may apply it once before the tag is zeroed; the explicit `updated_at` bump forces the next poll to reload and hit the corrupted secret.)

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run packages/server/src/config.test.ts && pnpm vitest run --project integration packages/server/src/servers-sync.itest.ts`
Expected: FAIL — `mcpCallTimeoutMs` undefined; cannot resolve `./servers-sync.js`.

- [ ] **Step 3: Implement**

`packages/server/src/config.ts`:

- `Schema` gains `MCP_CALL_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),`
- `Config` gains `readonly mcpCallTimeoutMs: number;`
- the built config gains `mcpCallTimeoutMs: v.MCP_CALL_TIMEOUT_MS,` and `toJSON` gains `mcpCallTimeoutMs: this.mcpCallTimeoutMs,`

`packages/server/src/servers-sync.ts`:

```ts
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
      o.log.error({ evt: 'servers.load_failed', server: e.slug, reason: e.reason }, 'server left out');
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
    o.log.info({ evt: 'servers.applied', count: configs.length, failed: errors.length }, 'servers applied');
  };

  // Serialized: a slow load can never be overtaken by a newer one and applied after it.
  const refresh = (): Promise<void> => {
    queue = queue
      .then(tick)
      .catch((err: unknown) => o.log.error({ evt: 'servers.sync_failed', err }, 'server sync failed'));
    return queue;
  };

  await refresh();
  const timer = setInterval(() => void refresh(), o.intervalMs ?? 5_000);
  timer.unref();
  return { scopeAll: () => scope, refresh, stop: () => clearInterval(timer) };
}
```

`packages/server/src/index.ts` — replace with:

```ts
import { VERSION } from '@mcprouter/core';

export function describe(): string {
  return `mcprouter ${VERSION}`;
}

export { createApp, type AppDeps, type McpDeps } from './app.js';
export { authenticateKey, createAuth, KEY_GRANT_ALL, type Auth } from './auth.js';
export { loadConfig, parseConfig, type Config } from './config.js';
export { createRegistry } from './metrics.js';
export { EMPTY_SCOPE, startServerSync, type ServerSync } from './servers-sync.js';
```

`packages/server/src/main.ts`:

- imports: `import { createDb, createLogger, createPool, Engine, runMigrations } from '@mcprouter/core';`, `import { authenticateKey, createAuth } from './auth.js';`, `import { EMPTY_SCOPE, startServerSync, type ServerSync } from './servers-sync.js';`
- after `const pool = createPool(config.databaseUrl);`:

```ts
const db = createDb(pool);
const engine = new Engine({ logger: log });
const auth = createAuth({ db, secret: config.authSecret, baseURL: config.publicUrl.href, log });
let sync: ServerSync | undefined;
```

- `createApp({ … })` gains:

```ts
  mcp: {
    authenticate: (header) => authenticateKey(auth, header),
    engine,
    // Before the first sync lands, an empty catalog — never "all" (P1a constraint).
    scopeAll: () => sync?.scopeAll() ?? EMPTY_SCOPE,
    timeoutMs: config.mcpCallTimeoutMs,
    authHandler: (req) => auth.handler(req),
  },
```

- after the migrations block (both branches), before `let shuttingDown`:

```ts
sync = await startServerSync({ pool, db, keyring: config.secretKeys, engine, log });
```

- in `shutdown`, before `await pool.end();`:

```ts
  sync?.stop();
  await engine.shutdown();
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm build && pnpm vitest run packages/server/src/config.test.ts && pnpm vitest run --project integration packages/server/src/servers-sync.itest.ts`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

Run: `pnpm lint && pnpm test`

```bash
git add packages/server
git commit -m "feat(server): engine follows the servers table; wire auth, engine and /mcp at boot"
```

---

### Task 6: The CLI, and the day-21 demo as a test

**Files:**
- Modify: `packages/cli/package.json`, `packages/cli/tsconfig.json`
- Create: `packages/cli/src/commands.ts`, `packages/cli/src/commands.test.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `packages/cli/src/demo.itest.ts`

**Interfaces:**
- Consumes: `createServer`, `generateKeyLine`, `type NewServer` (core); `createAuth`, `KEY_GRANT_ALL`, `type Auth`, and for the demo `createApp`, `createRegistry`, `parseConfig`, `startServerSync`, `authenticateKey` (server).
- Produces:
  - `class CliError extends Error`
  - `secretLines(): string[]` — `AUTH_SECRET=…` and `MCPR_SECRET_KEYS=v1:…`
  - `parseServerAdd(argv: string[], environment: Record<string, string | undefined>): NewServer`
  - `addUser(pool: pg.Pool, input: { email: string; name: string; role: 'viewer' | 'operator' | 'admin' }): Promise<string>`
  - `createKey(auth: Auth, pool: pg.Pool, input: { email: string; name: string }): Promise<string>`

- [ ] **Step 1: Wire the package**

`packages/cli/package.json` gains:

```json
  "dependencies": {
    "@mcprouter/core": "workspace:*",
    "@mcprouter/server": "workspace:*"
  }
```

`packages/cli/tsconfig.json` gains `"references": [{ "path": "../core" }, { "path": "../server" }]` (keep its existing fields). Run: `pnpm install`. Expected: exit 0.

- [ ] **Step 2: Write the failing unit test**

`packages/cli/src/commands.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CliError, parseServerAdd, secretLines } from './commands.js';

describe('secretLines', () => {
  it('prints an AUTH_SECRET and a keyring line, fresh each time', () => {
    const [a, k] = secretLines();
    expect(a).toMatch(/^AUTH_SECRET=[A-Za-z0-9_-]{43}$/);
    expect(k).toMatch(/^MCPR_SECRET_KEYS=v1:[A-Za-z0-9_-]{43}$/);
    expect(secretLines()[0]).not.toBe(a);
  });
});

describe('parseServerAdd', () => {
  it('stdio: the command follows --, env values literal or taken from the environment', () => {
    const s = parseServerAdd(
      ['fs', '--env', 'A=1', '--env', 'TOKEN', '--cwd', '/srv', '--', 'npx', '-y', 'pkg', '/tmp'],
      { TOKEN: 's3cret' },
    );
    expect(s).toEqual({
      slug: 'fs',
      enabled: true,
      allowPrivateNetwork: false,
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg', '/tmp'],
        env: { A: '1', TOKEN: 's3cret' },
        cwd: '/srv',
      },
    });
  });

  it('http: --url, --sse, headers literal or from the environment', () => {
    const s = parseServerAdd(
      ['gh', '--url', 'https://mcp.example.com/sse', '--sse', '--header', 'X-Team=core', '--header', 'Authorization', '--allow-private-network', '--disabled'],
      { AUTHORIZATION: 'Bearer t' },
    );
    expect(s).toEqual({
      slug: 'gh',
      enabled: false,
      allowPrivateNetwork: true,
      config: {
        type: 'sse',
        url: 'https://mcp.example.com/sse',
        headers: { 'X-Team': 'core', Authorization: 'Bearer t' },
      },
    });
  });

  it('defaults to streamable-http without --sse', () => {
    expect(parseServerAdd(['r', '--url', 'https://a.example/mcp'], {}).config.type).toBe(
      'streamable-http',
    );
  });

  it.each([
    ['no slug', []],
    ['neither --url nor a command', ['fs']],
    ['both --url and a command', ['fs', '--url', 'https://a.example', '--', 'npx']],
    ['an env name missing from the environment', ['fs', '--env', 'NOPE', '--', 'npx']],
    ['an unknown flag', ['fs', '--shell', '--', 'npx']],
  ])('rejects %s', (_n, argv) => {
    expect(() => parseServerAdd(argv, {})).toThrow(CliError);
  });
});
```

Run: `pnpm vitest run packages/cli/src/commands.test.ts`
Expected: FAIL — cannot resolve `./commands.js`.

- [ ] **Step 3: Implement the commands**

`packages/cli/src/commands.ts`:

```ts
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import type pg from 'pg';
import { generateKeyLine, type NewServer } from '@mcprouter/core';
import { KEY_GRANT_ALL, type Auth } from '@mcprouter/server';

/** A usage error: printed as one line, exit 1, no stack. */
export class CliError extends Error {
  override name = 'CliError';
}

export function secretLines(): string[] {
  return [`AUTH_SECRET=${randomBytes(32).toString('base64url')}`, generateKeyLine()];
}

/**
 * `KEY=value`, or a bare `KEY` read from the CLI's own environment — so a
 * token never has to appear in shell history. Header names map to variable
 * names by upper-casing and `-` → `_` (Authorization → AUTHORIZATION).
 */
function pairs(
  items: string[],
  environment: Record<string, string | undefined>,
  varName: (k: string) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    const eq = item.indexOf('=');
    if (eq > 0) {
      out[item.slice(0, eq)] = item.slice(eq + 1);
      continue;
    }
    const value = environment[varName(item)];
    if (value === undefined) throw new CliError(`${varName(item)} is not set in the environment`);
    out[item] = value;
  }
  return out;
}

export function parseServerAdd(
  argv: string[],
  environment: Record<string, string | undefined>,
): NewServer {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        url: { type: 'string' },
        sse: { type: 'boolean', default: false },
        header: { type: 'string', multiple: true, default: [] },
        env: { type: 'string', multiple: true, default: [] },
        cwd: { type: 'string' },
        'allow-private-network': { type: 'boolean', default: false },
        disabled: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;
  const [slug, command, ...args] = positionals;
  if (slug === undefined) throw new CliError('usage: mcprouter servers add <slug> (--url <url> | -- <command> [args…])');
  if ((values.url === undefined) === (command === undefined)) {
    throw new CliError('give exactly one of --url <url> or -- <command> [args…]');
  }
  const base = {
    slug,
    enabled: !values.disabled,
    allowPrivateNetwork: values['allow-private-network'],
  };
  if (values.url !== undefined) {
    return {
      ...base,
      config: {
        type: values.sse ? 'sse' : 'streamable-http',
        url: values.url,
        headers: pairs(values.header, environment, (k) => k.toUpperCase().replaceAll('-', '_')),
      },
    };
  }
  return {
    ...base,
    config: {
      type: 'stdio',
      command: command as string,
      args,
      env: pairs(values.env, environment, (k) => k),
      ...(values.cwd === undefined ? {} : { cwd: values.cwd }),
    },
  };
}

export async function addUser(
  pool: pg.Pool,
  input: { email: string; name: string; role: 'viewer' | 'operator' | 'admin' },
): Promise<string> {
  const id = randomUUID();
  await pool.query('insert into "user" (id, name, email, role) values ($1, $2, $3, $4)', [
    id,
    input.name,
    input.email,
    input.role,
  ]);
  return id;
}

/** R3: in P1 the CLI is the only minter and `all` the only grant. P2 moves minting to POST /api/keys. */
export async function createKey(
  auth: Auth,
  pool: pg.Pool,
  input: { email: string; name: string },
): Promise<string> {
  const r = await pool.query<{ id: string }>('select id from "user" where email = $1', [input.email]);
  const userId = r.rows[0]?.id;
  if (userId === undefined) {
    throw new CliError(`no user with email ${input.email} — run \`mcprouter users add\` first`);
  }
  const k = await auth.api.createApiKey({
    body: { name: input.name, userId, permissions: KEY_GRANT_ALL },
  });
  return k.key;
}
```

If `import type pg from 'pg'` does not resolve from `packages/cli`, add `"@types/pg"` resolution by importing the pool type from core instead: `type Pool = ReturnType<typeof createPool>` with `import type { createPool } from '@mcprouter/core'` — and ledger it.

Run: `pnpm build && pnpm vitest run packages/cli/src/commands.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing demo test**

`packages/cli/src/demo.itest.ts` — the §13 P1 demo, minus Claude Code itself: a user, a key, `servers add` of a real child process whose token is sealed at rest, and a real MCP client listing and calling through `POST /mcp` with the bearer key.

```ts
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDb, createPool, createServer, Engine, runMigrations } from '@mcprouter/core';
import {
  authenticateKey,
  createApp,
  createAuth,
  createRegistry,
  parseConfig,
  startServerSync,
  type ServerSync,
} from '@mcprouter/server';
import { addUser, createKey, parseServerAdd } from './commands.js';

// A dependency-free MCP server that reports whether its sealed token arrived.
const UPSTREAM = `
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const server = new McpServer({ name: 'demo', version: '0.0.0' });
server.registerTool('whoami', { description: 'token check', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: process.env.DEMO_TOKEN ?? 'missing' }],
}));
server.connect(new StdioServerTransport());
`;
// `node -e` resolves require() from cwd; the SDK is linked into packages/core.
const CORE_DIR = fileURLToPath(new URL('../../core', import.meta.url));

const log = pino({ level: 'silent' });
let pg: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createPool>;
let engine: Engine;
let sync: ServerSync;
let app: ReturnType<typeof createApp>;
let key: string;

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

  // $ mcprouter users add --email me@x.io --name Me --role admin
  await addUser(pool, { email: 'me@x.io', name: 'Me', role: 'admin' });
  // $ mcprouter keys create --email me@x.io --name laptop
  key = await createKey(auth, pool, { email: 'me@x.io', name: 'laptop' });
  // $ DEMO_TOKEN=… mcprouter servers add demo --env DEMO_TOKEN --cwd … -- node -e …
  await createServer(
    db,
    config.secretKeys,
    parseServerAdd(['demo', '--env', 'DEMO_TOKEN', '--cwd', CORE_DIR, '--', process.execPath, '-e', UPSTREAM], {
      DEMO_TOKEN: 's3cret-token',
    }),
  );

  engine = new Engine({ logger: log });
  sync = await startServerSync({ pool, db, keyring: config.secretKeys, engine, log, intervalMs: 200 });
  app = createApp({
    config,
    log,
    pool,
    registry: createRegistry(),
    readiness: { migrationsApplied: true, routesMounted: true },
    mcp: {
      authenticate: (h) => authenticateKey(auth, h),
      engine,
      scopeAll: () => sync.scopeAll(),
      timeoutMs: 30_000,
      authHandler: (req) => auth.handler(req),
    },
  });
}, 120_000);

afterAll(async () => {
  sync?.stop();
  await engine?.shutdown();
  await pool?.end();
  await pg?.stop();
});

function connect(bearer: string): Promise<Client> {
  const c = new Client({ name: 'claude-code-stand-in', version: '0.0.0' });
  return c
    .connect(
      new StreamableHTTPClientTransport(new URL('http://hub.test/mcp'), {
        requestInit: { headers: { authorization: `Bearer ${bearer}` } },
        fetch: (url, init) => app.request(String(url), init),
      }),
    )
    .then(() => c);
}

describe('day-21 demo', () => {
  it('a real client lists and calls a real upstream through POST /mcp with a bearer key', async () => {
    const c = await connect(key);
    await expect
      .poll(async () => (await c.listTools()).tools.map((t) => t.name), { timeout: 30_000 })
      .toEqual(['demo__whoami']);
    const res = await c.callTool({ name: 'demo__whoami', arguments: {} });
    // The token was sealed by `servers add`, opened by the loader, and reached the child.
    expect(JSON.stringify(res.content)).toContain('s3cret-token');
    await c.close();
  });

  it('the same request with a wrong key never reaches the engine', async () => {
    await expect(connect('mcpr_wrong')).rejects.toThrow();
  });
});
```

Run: `pnpm vitest run --project integration packages/cli/src/demo.itest.ts`
Expected before Step 5: PASS is possible because every piece already exists — **that is expected here**: this test is the acceptance check composing Tasks 1–5, not a unit under construction. Prove it can fail: temporarily change `KEY_GRANT_ALL` in `packages/server/src/auth.ts` to `{ mcp: ['read'] }`, rebuild, run — Expected: FAIL (401 on connect). Revert, rebuild, run — Expected: PASS.

- [ ] **Step 5: The entry point**

`packages/cli/src/main.ts`:

```ts
import { parseArgs } from 'node:util';
import { createDb, createLogger, createPool, createServer } from '@mcprouter/core';
import { createAuth, loadConfig } from '@mcprouter/server';
import { addUser, CliError, createKey, parseServerAdd, secretLines } from './commands.js';

const HELP = `mcprouter <command>

  secret                                      print a fresh AUTH_SECRET and MCPR_SECRET_KEYS
  users add --email <e> --name <n> [--role viewer|operator|admin]
  keys create --email <e> [--name <n>]        print a new API key (shown once)
  servers add <slug> --url <url> [--sse] [--header K=V | --header K]… [--allow-private-network] [--disabled]
  servers add <slug> [--env K=V | --env K]… [--cwd <dir>] -- <command> [args…]

Every command except 'secret' reads the server's configuration from the environment.
`;

const [, , cmd, sub, ...rest] = process.argv;

async function run(): Promise<void> {
  if (cmd === undefined || cmd === 'help' || cmd === '--help') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === 'secret') {
    process.stdout.write(`${secretLines().join('\n')}\n`);
    return;
  }
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    const db = createDb(pool);
    if (cmd === 'users' && sub === 'add') {
      const { values } = parseArgs({
        args: rest,
        options: {
          email: { type: 'string' },
          name: { type: 'string' },
          role: { type: 'string', default: 'viewer' },
        },
      });
      const role = values.role;
      if (values.email === undefined || values.name === undefined) throw new CliError('--email and --name are required');
      if (role !== 'viewer' && role !== 'operator' && role !== 'admin') throw new CliError('--role must be viewer, operator or admin');
      process.stdout.write(`${await addUser(pool, { email: values.email, name: values.name, role })}\n`);
    } else if (cmd === 'keys' && sub === 'create') {
      const { values } = parseArgs({
        args: rest,
        options: { email: { type: 'string' }, name: { type: 'string', default: 'cli' } },
      });
      if (values.email === undefined) throw new CliError('--email is required');
      const log = createLogger({ level: 'warn', file: undefined, pretty: false });
      const auth = createAuth({ db, secret: config.authSecret, baseURL: config.publicUrl.href, log });
      process.stdout.write(`${await createKey(auth, pool, { email: values.email, name: values.name })}\n`);
    } else if (cmd === 'servers' && sub === 'add') {
      const input = parseServerAdd(rest, process.env);
      process.stdout.write(`${await createServer(db, config.secretKeys, input)}\n`);
    } else {
      throw new CliError(`unknown command: ${[cmd, sub].filter(Boolean).join(' ')}`);
    }
  } finally {
    await pool.end();
  }
}

run().catch((err: unknown) => {
  process.stderr.write(`${err instanceof CliError ? err.message : String(err)}\n`);
  process.exit(1);
});
```

(`createLogger`'s option names are whatever `packages/core/src/obs/log.ts` declares — match them; `pretty: false` keeps the CLI's stdout clean for piping the key.)

Run: `pnpm build && node packages/cli/dist/main.js secret`
Expected: two lines, `AUTH_SECRET=…` and `MCPR_SECRET_KEYS=v1:…`.

Run: `node packages/cli/dist/main.js bogus; echo exit=$?`
Expected: `unknown command: bogus` — wait, `bogus` reaches `loadConfig()` first and exits 78 without the environment. That is acceptable (configuration is checked before dispatch); with the environment set it prints `unknown command: bogus` and exits 1.

- [ ] **Step 6: Gates and commit**

Run: `pnpm lint && pnpm vitest run --coverage && pnpm db:check`
Expected: exit 0, all coverage gates (including `packages/server/src/mcp/**` 85/75) pass.

```bash
git add packages/cli pnpm-lock.yaml
git commit -m "feat(cli): secret, users add, keys create, servers add; the day-21 demo as a test"
```

---

## P1c Acceptance

1. `pnpm build && pnpm lint && pnpm vitest run --coverage && pnpm db:check` green, zero lint warnings.
2. `grep -rn session packages/core/src --exclude=auth.ts` prints nothing; `packages/core/package.json` has no `hono`/`better-auth`.
3. `demo.itest.ts` passes: key → `POST /mcp` → real child process → sealed token delivered.
4. Manual, against `docker compose up` (R9 — CLI from the checkout):

```bash
export DATABASE_URL=postgres://mcprouter:mcprouter@localhost:5432/mcprouter PUBLIC_URL=http://localhost:3000
# AUTH_SECRET and MCPR_SECRET_KEYS: the same values the compose app uses
node packages/cli/dist/main.js users add --email me@example.com --name Me --role admin
node packages/cli/dist/main.js keys create --email me@example.com --name laptop   # → mcpr_…
node packages/cli/dist/main.js servers add fs -- npx -y @modelcontextprotocol/server-filesystem /tmp
claude mcp add --transport http hub http://localhost:3000/mcp --header "Authorization: Bearer mcpr_…"
```

Within 5 s Claude Code lists `fs__read_file` and friends and can call one.

## Self-Review

**Spec coverage (§13 P1, server half):** `POST /mcp` legacy-era Streamable HTTP → T3/T4 · 405 GET/DELETE → T4 · better-auth core + apiKey as configuration → T2 · `mcprouter servers add` → T6 · the day-21 demo → T6 test + acceptance 4. §4.2: route table rows for `{kind:'all'}`, 405, 404, `/api/auth/*` → T4; the three measured constraints → T3 (per-request build, JSON response, `X-Accel-Buffering`) + T4 (gateway 405); `bodyLimit` + deadline → T4/T3. §5.2: `enableSessionForAPIKeys:false`, `enableMetadata:false`, grant in `permissions` fail-closed, plugin routes 404, admin key not admin → T2/T4. §5.3: `role` `input:false` → T2.

**Deferred by design:** groups/servers/smart routes and `checkGrant` (P2) · `POST /api/keys` with subset check (P2, R3) · human login + bootstrap claim (P3, R2) · per-principal 429 and 1 MB cap (P2, R7) · OAuth `mcp` plugin and `/.well-known` PRM (later phase, R6) · CLI in the image (R9).

**Type consistency:** `McpCall` (T3) is consumed only by `mountMcp` (T4). `McpDeps.authenticate` matches `authenticateKey(auth, h)` partially applied (T2 → T5). `ServerSync.scopeAll` (T5) feeds `McpDeps.scopeAll` (T4). `NewServer` (P1b) is `parseServerAdd`'s return (T6). `KEY_GRANT_ALL` is the one grant literal, used by `createKey` and the tests.

**Placeholder scan:** none. Three steps name a fallback if the installed `.d.ts` disagrees (T2 logger signature, T3 not-found class, T6 `pg` types) — each with the concrete alternative and a ledger instruction.
