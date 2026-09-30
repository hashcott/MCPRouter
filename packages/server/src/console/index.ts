import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type pg from 'pg';
import { z } from 'zod';
import {
  createServer,
  PlainServerConfig,
  type Db,
  type Engine,
  type Keyring,
} from '@mcprouter/core';
import type { AuditRow } from '../app.js';
import { passwordHasher, sessionUser, type Auth, type SessionUser } from '../auth.js';
import { parseGrant } from '../grant.js';
import { ArgConstraints, ROLES, type Role } from '../policy.js';
import { claimBootstrap } from './bootstrap.js';
import * as ops from './ops.js';

export type ConsoleDeps = {
  auth: Auth;
  db: Db;
  pool: pg.Pool;
  engine: Engine;
  keyring: Keyring;
  publicUrl: URL;
  audit: (row: AuditRow) => void;
};

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
const Slug = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/);
const Email = z.email().max(254);
const Password = z.string().min(12).max(256);

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new HttpError(400, 'invalid body', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

/**
 * The console REST projection (§9.2), all under /api, all SESSION-cookie auth (an
 * API key is never a console credential, §5.2). Roles are one axis (§5.3):
 * viewer reads · operator adds/edits servers, groups, its own keys, reviews ·
 * admin adds users, and owns policy.
 */
export function mountConsole(app: Hono, d: ConsoleDeps): void {
  const hash = passwordHasher(d.auth);

  // No console body is large; an unauthenticated one (bootstrap, sign-in) must not buffer GBs.
  app.use(
    '/api/*',
    bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
  );

  // CSRF, for every state-changing console request (better-auth guards its own /api/auth/*).
  app.use('/api/*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/api/auth/') || ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      return next();
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== d.publicUrl.origin) {
      return c.json({ error: 'cross-origin request refused' }, 403);
    }
    // Only POST can come from a plain HTML form; PATCH/PUT/DELETE cross-site always need a
    // CORS preflight we never grant. So the JSON requirement is POST's, Origin is everyone's.
    if (
      c.req.method === 'POST' &&
      !(c.req.header('content-type') ?? '').includes('application/json')
    ) {
      return c.json({ error: 'content-type must be application/json' }, 415);
    }
    return next();
  });

  const audit = (user: SessionUser | null, evt: string, target: Partial<AuditRow> = {}) =>
    d.audit({
      evt: evt as AuditRow['evt'],
      requestId: null,
      principalId: user?.id ?? 'bootstrap',
      keyId: null,
      route: 'console',
      server: null,
      item: null,
      outcome: 'ok',
      durationMs: 0,
      inputKeys: [],
      inputBytes: 0,
      error: null,
      ...target,
    });

  /** Role-checked handler with one error mapping for the whole console. */
  const as =
    (min: Role, h: (c: Context, u: SessionUser) => Promise<Response>) =>
    async (c: Context): Promise<Response> => {
      try {
        const u = await sessionUser(d.auth, c.req.raw.headers);
        if (u === null) return c.json({ error: 'sign in required' }, 401);
        if (RANK[u.role] < RANK[min]) return c.json({ error: `${min} role required` }, 403);
        return await h(c, u);
      } catch (err) {
        if (err instanceof HttpError)
          return c.json({ error: err.message, ...err.extra }, err.status);
        if (err instanceof ops.OpError) return c.json({ error: err.message }, err.status);
        const code = ops.pgCode(err);
        if (code === '23505') return c.json({ error: 'already exists' }, 409);
        if (code === '23514') return c.json({ error: 'invalid value' }, 400);
        if (code === '22P02') return c.json({ error: 'not found' }, 404); // a malformed id names nothing
        throw err;
      }
    };

  // ── bootstrap: the ONE unauthenticated write, and only while zero users exist ────
  app.post('/api/bootstrap', async (c) => {
    try {
      const b = await body(
        c,
        z.strictObject({
          token: z.string().min(1).max(200),
          email: Email,
          name: z.string().min(1).max(100),
          password: Password,
        }),
      );
      const id = await claimBootstrap(
        d.pool,
        { token: b.token, email: b.email, name: b.name, password: b.password },
        hash,
      );
      // Wrong token, or already claimed: one answer for both.
      if (id === null) return c.json({ error: 'invalid or already used bootstrap token' }, 403);
      audit({ id, email: b.email, name: b.name, role: 'admin' }, 'bootstrap.claimed');
      // Sign the new admin in: the session cookie comes back from better-auth itself.
      return await d.auth.api.signInEmail({
        body: { email: b.email, password: b.password },
        asResponse: true,
      });
    } catch (err) {
      if (err instanceof HttpError) return c.json({ error: err.message, ...err.extra }, err.status);
      throw err;
    }
  });

  app.get(
    '/api/me',
    as('viewer', async (c, u) => c.json(u)),
  );

  // ── servers ──────────────────────────────────────────────────────────────────────
  app.get(
    '/api/servers',
    as('viewer', async (c) => {
      const rows = await d.pool.query<{
        id: string;
        slug: string;
        enabled: boolean;
        type: string;
        allow_private_network: boolean;
        credential_mode: string;
      }>(
        `select id, slug, enabled, config->>'type' as type, allow_private_network, credential_mode
         from servers order by slug`,
      );
      const status = new Map(d.engine.status().map((s) => [s.name, s]));
      return c.json(
        rows.rows.map((r) => {
          const s = status.get(r.slug);
          return {
            id: r.id,
            slug: r.slug,
            enabled: r.enabled,
            type: r.type,
            allowPrivateNetwork: r.allow_private_network,
            credentialMode: r.credential_mode,
            state: s?.state ?? 'unknown',
            toolCount: s?.toolCount ?? 0,
            lastError: s?.lastError ?? null,
          };
        }),
      );
    }),
  );

  app.post(
    '/api/servers',
    as('operator', async (c, u) => {
      const b = await body(
        c,
        z.strictObject({
          slug: Slug,
          // Plaintext values in: createServer seals every env/header value before storage.
          config: PlainServerConfig,
          enabled: z.boolean().default(true),
          allowPrivateNetwork: z.boolean().default(false),
          credentialMode: z.enum(['shared', 'per-user']).default('shared'),
        }),
      );
      const id = await createServer(d.db, d.keyring, b);
      audit(u, 'config.server.create', {
        server: b.slug,
        // The key NAMES that were sealed — never their values.
        inputKeys: Object.keys('env' in b.config ? b.config.env : b.config.headers),
      });
      return c.json({ id }, 201);
    }),
  );

  app.patch(
    '/api/servers/:slug',
    as('operator', async (c, u) => {
      const b = await body(c, z.strictObject({ enabled: z.boolean() }));
      const slug = c.req.param('slug') ?? '';
      const r = await d.pool.query(
        'update servers set enabled = $2, updated_at = now() where slug = $1',
        [slug, b.enabled],
      );
      if (r.rowCount === 0) throw new HttpError(404, `no server named ${slug}`);
      audit(u, b.enabled ? 'config.server.enable' : 'config.server.disable', { server: slug });
      return c.json({ ok: true });
    }),
  );

  app.delete(
    '/api/servers/:slug',
    as('operator', async (c, u) => {
      const slug = c.req.param('slug') ?? '';
      if (u.role !== 'admin') {
        // Policy is the admin's (§5.3); a delete would cascade it away and a re-add would
        // bring the server back without its denies. Only an admin may do that.
        const rules = await d.pool.query(
          'select 1 from policy_rule p join servers s on s.id = p.server_id where s.slug = $1 limit 1',
          [slug],
        );
        if (rules.rowCount === 1) {
          throw new HttpError(409, `policy rules target ${slug}; an admin must delete this server`);
        }
      }
      const r = await d.pool.query('delete from servers where slug = $1', [slug]);
      if (r.rowCount === 0) throw new HttpError(404, `no server named ${slug}`);
      audit(u, 'config.server.delete', { server: slug });
      return c.json({ ok: true });
    }),
  );

  app.get(
    '/api/servers/:slug/items',
    as('viewer', async (c) =>
      c.json(
        await ops.listReviews(d.pool, { server: c.req.param('slug') ?? '', includeApproved: true }),
      ),
    ),
  );

  app.patch(
    '/api/servers/:slug/tools/:tool',
    as('operator', async (c, u) => {
      const b = await body(c, z.strictObject({ enabled: z.boolean() }));
      const server = c.req.param('slug') ?? '';
      const tool = c.req.param('tool') ?? '';
      await ops.setToolEnabled(d.pool, { server, tool, enabled: b.enabled });
      audit(u, b.enabled ? 'config.tool.enable' : 'config.tool.disable', { server, item: tool });
      return c.json({ ok: true });
    }),
  );

  // ── groups ───────────────────────────────────────────────────────────────────────
  app.get(
    '/api/groups',
    as('viewer', async (c) => {
      const r = await d.pool.query<{
        slug: string;
        server: string | null;
        alias: string | null;
        tools: unknown;
      }>(
        `select g.slug, s.slug as server, m.alias, m.tools
         from groups g
         left join group_server m on m.group_id = g.id
         left join servers s on s.id = m.server_id
         order by g.slug, s.slug`,
      );
      const groups = new Map<
        string,
        { slug: string; members: { server: string; alias: string | null; tools: unknown }[] }
      >();
      for (const row of r.rows) {
        const g = groups.get(row.slug) ?? { slug: row.slug, members: [] };
        groups.set(row.slug, g);
        if (row.server !== null)
          g.members.push({ server: row.server, alias: row.alias, tools: row.tools });
      }
      return c.json([...groups.values()]);
    }),
  );

  app.post(
    '/api/groups',
    as('operator', async (c, u) => {
      const b = await body(
        c,
        z.strictObject({
          slug: Slug,
          members: z
            .array(
              z.strictObject({
                server: Slug,
                tools: z
                  .union([z.literal('all'), z.array(z.string().min(1).max(128)).min(1)])
                  .default('all'),
              }),
            )
            .max(200),
        }),
      );
      const id = await ops.addGroup(d.pool, b);
      audit(u, 'config.group.create', { item: b.slug });
      return c.json({ id }, 201);
    }),
  );

  app.delete(
    '/api/groups/:slug',
    as('operator', async (c, u) => {
      const slug = c.req.param('slug') ?? '';
      const r = await d.pool.query('delete from groups where slug = $1', [slug]);
      if (r.rowCount === 0) throw new HttpError(404, `no group named ${slug}`);
      audit(u, 'config.group.delete', { item: slug });
      return c.json({ ok: true });
    }),
  );

  // ── keys: the ONE minting path (§5.2) ────────────────────────────────────────────
  app.get(
    '/api/keys',
    as('operator', async (c, u) => {
      // An operator sees their own keys; an admin may ask for everyone's.
      const all = u.role === 'admin' && c.req.query('all') === 'true';
      const r = await d.pool.query<{
        id: string;
        name: string | null;
        start: string | null;
        enabled: boolean | null;
        expires_at: Date | null;
        created_at: Date;
        permissions: string | null;
        owner: string;
      }>(
        `select k.id, k.name, k.start, k.enabled, k.expires_at, k.created_at, k.permissions, u.email as owner
         from apikey k join "user" u on u.id = k.reference_id
         where ($1 or k.reference_id = $2)
         order by k.created_at desc`,
        [all, u.id],
      );
      return c.json(
        r.rows.map((k) => {
          let parsed: unknown = null;
          try {
            parsed = k.permissions === null ? null : JSON.parse(k.permissions);
          } catch {
            parsed = null;
          }
          return {
            id: k.id,
            name: k.name,
            start: k.start,
            enabled: k.enabled !== false,
            expiresAt: k.expires_at,
            createdAt: k.created_at,
            owner: k.owner,
            // Shown as the gateway will read it: an unparseable grant is shown as none.
            grant: parseGrant(parsed),
          };
        }),
      );
    }),
  );

  app.post(
    '/api/keys',
    as('operator', async (c, u) => {
      const b = await body(
        c,
        z.strictObject({
          name: z.string().min(1).max(100),
          groups: z.array(Slug).max(50).default([]),
          servers: z.array(Slug).max(50).default([]),
          expiresInDays: z.int().min(1).max(365).optional(),
        }),
      );
      const minted = await ops.createKey(d.auth, d.pool, {
        owner: { userId: u.id },
        name: b.name,
        groups: b.groups,
        servers: b.servers,
        expiresInDays: b.expiresInDays,
      });
      audit(u, 'config.key.create', { item: minted.id });
      return c.json(
        {
          id: minted.id,
          start: minted.start,
          // The ONLY time the key is shown. The console copies the block; nothing stores it.
          key: minted.key,
          client: clientConfig(d.publicUrl, b.groups, b.servers, minted.key),
        },
        201,
      );
    }),
  );

  app.delete(
    '/api/keys/:id',
    as('operator', async (c, u) => {
      const id = c.req.param('id') ?? '';
      const r = await d.pool.query(
        'delete from apikey where id = $1 and ($2 or reference_id = $3)',
        [id, u.role === 'admin', u.id],
      );
      // Someone else's key and a missing key are the same 404.
      if (r.rowCount === 0) throw new HttpError(404, `no key ${id}`);
      audit(u, 'config.key.delete', { item: id });
      return c.json({ ok: true });
    }),
  );

  // ── users (admin) ────────────────────────────────────────────────────────────────
  app.get(
    '/api/users',
    as('admin', async (c) => {
      const r = await d.pool.query(
        `select id, email, name, role, created_at as "createdAt" from "user" order by email`,
      );
      return c.json(r.rows);
    }),
  );

  app.post(
    '/api/users',
    as('admin', async (c, u) => {
      const b = await body(
        c,
        z.strictObject({
          email: Email,
          name: z.string().min(1).max(100),
          role: z.enum(ROLES),
          password: Password,
        }),
      );
      const id = await ops.addUser(d.pool, b, hash);
      audit(u, 'config.user.create', { item: b.email });
      return c.json({ id }, 201);
    }),
  );

  app.patch(
    '/api/users/:id',
    as('admin', async (c, u) => {
      const b = await body(c, z.strictObject({ role: z.enum(ROLES) }));
      const id = c.req.param('id') ?? '';
      await changeUser(d.pool, id, async (client) => {
        await client.query('update "user" set role = $2, updated_at = now() where id = $1', [
          id,
          b.role,
        ]);
      });
      audit(u, 'config.user.role', { item: id, error: b.role });
      return c.json({ ok: true });
    }),
  );

  app.delete(
    '/api/users/:id',
    as('admin', async (c, u) => {
      const id = c.req.param('id') ?? '';
      if (id === u.id) throw new HttpError(409, 'you cannot delete yourself');
      await changeUser(d.pool, id, async (client) => {
        // apikey.reference_id has no FK to user: revoke the keys explicitly, in the same
        // transaction, so a deleted person's keys never outlive them.
        await client.query('delete from apikey where reference_id = $1', [id]);
        await client.query('delete from "user" where id = $1', [id]);
      });
      audit(u, 'config.user.delete', { item: id });
      return c.json({ ok: true });
    }),
  );

  // ── review (integrity, §11.2) ────────────────────────────────────────────────────
  app.get(
    '/api/review',
    as('operator', async (c) => {
      const server = c.req.query('server');
      return c.json(await ops.listReviews(d.pool, server === undefined ? {} : { server }));
    }),
  );

  const Item = {
    server: Slug,
    kind: z.enum(['tool', 'prompt', 'resource']),
    name: z.string().min(1).max(2_048),
  };

  app.post(
    '/api/review/approve',
    as('operator', async (c, u) => {
      const b = await body(
        c,
        z.strictObject({ ...Item, defHash: z.string().regex(/^[0-9a-f]{64}$/) }),
      );
      try {
        await ops.approveItem(d.pool, { ...b, hash: b.defHash, by: u.id });
      } catch (err) {
        if (err instanceof ops.OpError && err.status === 409) {
          // TOCTOU (§11.2): the definition moved since it was shown — 409 with the current state.
          const now = (
            await ops.listReviews(d.pool, { server: b.server, includeApproved: true })
          ).find((x) => x.kind === b.kind && x.name === b.name);
          throw new HttpError(409, err.message, { current: now ?? null });
        }
        throw err;
      }
      audit(u, 'review.approve', { server: b.server, item: b.name });
      return c.json({ ok: true });
    }),
  );

  app.post(
    '/api/review/reject',
    as('operator', async (c, u) => {
      const b = await body(c, z.strictObject(Item));
      await ops.rejectItem(d.pool, b);
      audit(u, 'review.reject', { server: b.server, item: b.name });
      return c.json({ ok: true });
    }),
  );

  // ── policy (admin writes, §5.3) ──────────────────────────────────────────────────
  app.get(
    '/api/policy',
    as('operator', async (c) => c.json(await ops.listPolicies(d.pool))),
  );

  app.post(
    '/api/policy',
    as('admin', async (c, u) => {
      const b = await body(
        c,
        z.strictObject({
          server: Slug,
          effect: z.enum(['allow', 'deny']),
          // Only tool rules are enforced in this version — refused, not silently kept (§11.4).
          kind: z.literal('tool').default('tool'),
          pattern: z
            .string()
            .regex(/^[A-Za-z0-9_*.:/-]{1,128}$/)
            .default('*'),
          subject: z
            .union([
              z.strictObject({ kind: z.literal('any') }),
              z.strictObject({ kind: z.literal('role'), id: z.enum(ROLES) }),
              z.strictObject({ kind: z.literal('api_key'), id: z.string().min(1).max(128) }),
            ])
            .default({ kind: 'any' }),
          args: z.array(z.unknown()).max(16).default([]),
          note: z.string().max(200).nullable().default(null),
          expiresAt: z.iso.datetime().nullable().default(null),
          seq: z.int().min(0).nullable().default(null),
        }),
      );
      const args = ArgConstraints.safeParse(b.args);
      if (!args.success) throw new HttpError(400, 'invalid argument constraint');
      if (b.effect === 'deny' && args.data.length > 0) {
        throw new HttpError(400, 'constraints belong on an allow rule; a deny is unconditional');
      }
      const id = await ops.addPolicy(d.pool, {
        ...b,
        args: args.data,
        expiresAt: b.expiresAt === null ? null : new Date(b.expiresAt),
      });
      audit(u, 'config.policy.create', { server: b.server, item: id });
      return c.json({ id }, 201);
    }),
  );

  app.delete(
    '/api/policy/:id',
    as('admin', async (c, u) => {
      const id = c.req.param('id') ?? '';
      await ops.removePolicy(d.pool, id);
      audit(u, 'config.policy.delete', { item: id });
      return c.json({ ok: true });
    }),
  );
}

/** Refuses to leave the install without an admin: the last admin cannot be demoted or deleted. */
async function changeUser(
  pool: pg.Pool,
  id: string,
  change: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Serializes concurrent admin changes on the admin set itself.
    await client.query(`select id from "user" where role = 'admin' for update`);
    const exists = await client.query('select 1 from "user" where id = $1', [id]);
    if (exists.rowCount === 0) throw new HttpError(404, `no user ${id}`);
    await change(client);
    const admins = await client.query(`select count(*)::int as n from "user" where role = 'admin'`);
    if ((admins.rows[0]?.n ?? 0) === 0)
      throw new HttpError(409, 'the last admin cannot be removed or demoted');
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The block an operator pastes into a client (§13 P3 demo). The URL is the route the
 * grant is good on: a group grant → its group routes; a servers grant → each server's
 * route; the unscoped grant → /mcp. `url` is the first; `urls` lists every one.
 */
export function clientConfig(
  publicUrl: URL,
  groups: readonly string[],
  servers: readonly string[],
  key: string,
): { url: string; urls: string[]; json: unknown; claudeCode: string } {
  const base = publicUrl.href.replace(/\/+$/, '');
  // A servers grant only passes where EVERY server of the route is in it (§4.2): that is
  // each server's own route, never /mcp (which holds every server).
  const urls =
    groups.length > 0
      ? groups.map((g) => `${base}/mcp/g/${g}`)
      : servers.length > 0
        ? servers.map((s) => `${base}/mcp/s/${s}`)
        : [`${base}/mcp`];
  const url = urls[0] as string;
  return {
    url,
    urls,
    json: {
      mcpServers: { mcprouter: { type: 'http', url, headers: { Authorization: `Bearer ${key}` } } },
    },
    claudeCode: `claude mcp add --transport http mcprouter ${url} --header "Authorization: Bearer ${key}"`,
  };
}
