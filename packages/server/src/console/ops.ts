import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Auth } from '../auth.js';
import { toPermissions, type Grant } from '../grant.js';
import {
  compileRules,
  describeRule,
  findShadows,
  type ArgConstraint,
  type Role,
  type RuleRow,
} from '../policy.js';

/**
 * Operations shared by the console API and the CLI — one implementation of every
 * write, so the two surfaces cannot drift. They throw OpError: the console maps it to
 * an HTTP status, the CLI to a one-line message.
 */
export class OpError extends Error {
  override name = 'OpError';
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A user row, and — when a password is given — its better-auth credential account,
 * hashed by better-auth itself. Sign-up over HTTP stays closed (P1c R2): people are
 * created by an admin (console) or an operator with database access (CLI).
 */
export async function addUser(
  pool: pg.Pool,
  input: { email: string; name: string; role: Role; password?: string | undefined },
  hash?: (password: string) => Promise<string>,
): Promise<string> {
  if (input.password !== undefined && hash === undefined) {
    throw new Error('addUser: a password needs the better-auth hasher');
  }
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('insert into "user" (id, name, email, role) values ($1, $2, $3, $4)', [
      id,
      input.name,
      input.email,
      input.role,
    ]);
    if (input.password !== undefined && hash !== undefined) {
      await client.query(
        `insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at)
         values ($1, $2, 'credential', $2, $3, now(), now())`,
        [randomUUID(), id, await hash(input.password)],
      );
    }
    await client.query('commit');
    return id;
  } catch (err) {
    await client.query('rollback');
    if ((err as { code?: string }).code === '23505') {
      throw new OpError(409, `a user with email ${input.email} already exists`);
    }
    throw err;
  } finally {
    client.release();
  }
}

export type MintedKey = { id: string; key: string; start: string | null };

/**
 * The one minting path (§5.2): the plugin's own routes stay dark. The grant names
 * existing groups or servers — resolved to ids, so a rename cannot widen a key.
 * In the one-axis model (§5.3) every operator reaches every team resource, so any
 * such grant is a subset of the creator's reach; viewers cannot mint at all.
 */
export async function createKey(
  auth: Auth,
  pool: pg.Pool,
  input: {
    owner: { email: string } | { userId: string };
    name: string;
    groups?: string[];
    servers?: string[];
    expiresInDays?: number | undefined;
  },
): Promise<MintedKey> {
  const groups = input.groups ?? [];
  const servers = input.servers ?? [];
  if (groups.length > 0 && servers.length > 0) {
    throw new OpError(400, 'a key is scoped to groups OR servers, not both');
  }
  let userId: string;
  if ('userId' in input.owner) {
    userId = input.owner.userId;
  } else {
    const r = await pool.query<{ id: string }>('select id from "user" where email = $1', [
      input.owner.email,
    ]);
    const found = r.rows[0]?.id;
    if (found === undefined) {
      throw new OpError(
        404,
        `no user with email ${input.owner.email} — run \`mcprouter users add\` first`,
      );
    }
    userId = found;
  }
  const grant: Grant =
    groups.length > 0
      ? { kind: 'groups', ids: await idsOf(pool, 'groups', groups) }
      : servers.length > 0
        ? { kind: 'servers', ids: await idsOf(pool, 'servers', servers) }
        : { kind: 'all' };
  const k = await auth.api.createApiKey({
    body: {
      name: input.name,
      userId,
      permissions: toPermissions(grant),
      ...(input.expiresInDays === undefined ? {} : { expiresIn: input.expiresInDays * 86_400 }),
    },
  });
  return { id: k.id, key: k.key, start: k.start ?? null };
}

async function idsOf(
  pool: pg.Pool,
  table: 'servers' | 'groups',
  slugs: string[],
): Promise<string[]> {
  const r = await pool.query<{ id: string; slug: string }>(
    `select id, slug from ${table} where slug = any($1)`,
    [slugs],
  );
  const bySlug = new Map(r.rows.map((x) => [x.slug, x.id]));
  return slugs.map((s) => {
    const id = bySlug.get(s);
    if (id === undefined)
      throw new OpError(404, `no ${table === 'servers' ? 'server' : 'group'} named ${s}`);
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
    const g = await client.query<{ id: string }>(
      'insert into groups (slug) values ($1) returning id',
      [input.slug],
    );
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

const KINDS = new Set(['tool', 'prompt', 'resource']);

function kindOf(k: string): 'tool' | 'prompt' | 'resource' {
  if (!KINDS.has(k)) throw new OpError(400, `kind must be tool, prompt or resource — got ${k}`);
  return k as 'tool' | 'prompt' | 'resource';
}

/** What needs a human: never reviewed, changed since approval, rejected, or defective. */
export async function listReviews(
  pool: pg.Pool,
  input: { server?: string; includeApproved?: boolean },
): Promise<
  {
    server: string;
    kind: 'tool' | 'prompt' | 'resource';
    name: string;
    state: string;
    defHash: string | null;
  }[]
> {
  const r = await pool.query(
    `select s.slug as server, te.kind, te.name, te.def_hash,
            case
              when te.defect is not null then 'defective'
              when coalesce(o.review_state, 'unreviewed') = 'rejected' then 'rejected'
              when coalesce(o.review_state, 'unreviewed') = 'unreviewed' then 'unreviewed'
              when o.approved_hash is distinct from te.def_hash then 'changed'
              else 'approved'
            end as state
     from tool_embedding te
     join servers s on s.id = te.server_id
     left join server_item_override o
       on o.server_id = te.server_id and o.kind = te.kind and o.item_name = te.name
     where ($1::text is null or s.slug = $1)
     order by s.slug, te.kind, te.name`,
    [input.server ?? null],
  );
  return r.rows
    .filter((x) => input.includeApproved === true || x.state !== 'approved')
    .map((x) => ({
      server: x.server,
      kind: x.kind,
      name: x.name,
      state: x.state,
      defHash: x.def_hash,
    }));
}

/**
 * TOCTOU-safe (§11.2): approves ONLY the definition whose hash the operator was
 * shown. If it changed again in between, nothing is written.
 */
export async function approveItem(
  pool: pg.Pool,
  input: { server: string; kind: string; name: string; hash: string; by?: string | null },
): Promise<void> {
  const r = await pool.query(
    `insert into server_item_override
       (server_id, kind, item_name, review_state, approved_hash, approved_def, approved_at, approved_by)
     select te.server_id, te.kind, te.name, 'approved', te.def_hash, te.def, now(), $5
     from tool_embedding te join servers s on s.id = te.server_id
     where s.slug = $1 and te.kind = $2 and te.name = $3 and te.def_hash = $4
     on conflict (server_id, kind, item_name) do update
       set review_state = 'approved', approved_hash = excluded.approved_hash,
           approved_def = excluded.approved_def, approved_at = now(),
           approved_by = excluded.approved_by, updated_at = now()`,
    [input.server, kindOf(input.kind), input.name, input.hash, input.by ?? null],
  );
  if (r.rowCount === 0) {
    throw new OpError(
      409,
      `${input.server} ${input.kind} ${input.name}: no definition with hash ${input.hash} — it changed or does not exist; run \`mcprouter review list\` again`,
    );
  }
}

export async function rejectItem(
  pool: pg.Pool,
  input: { server: string; kind: string; name: string },
): Promise<void> {
  const [serverId] = await idsOf(pool, 'servers', [input.server]);
  await pool.query(
    `insert into server_item_override (server_id, kind, item_name, review_state) values ($1, $2, $3, 'rejected')
     on conflict (server_id, kind, item_name) do update
       set review_state = 'rejected', approved_hash = null, approved_def = null, approved_at = null, updated_at = now()`,
    [serverId, kindOf(input.kind), input.name],
  );
}

export type PolicyAdd = {
  server: string;
  effect: 'allow' | 'deny';
  kind: 'tool' | 'prompt' | 'resource';
  pattern: string;
  subject: { kind: 'any' } | { kind: 'role' | 'api_key'; id: string };
  args: ArgConstraint[];
  note: string | null;
  expiresAt: Date | null;
  seq: number | null;
};

/** Appends at the end unless --seq is given: first match means position is meaning. */
export async function addPolicy(pool: pg.Pool, p: PolicyAdd): Promise<string> {
  const [serverId] = await idsOf(pool, 'servers', [p.server]);
  if (p.subject.kind === 'api_key') {
    // A typo'd key id would make a break-glass deny that matches nobody and looks active.
    const k = await pool.query('select 1 from apikey where id = $1', [p.subject.id]);
    if (k.rowCount === 0) throw new OpError(400, `no API key with id ${p.subject.id}`);
  }
  const r = await pool.query<{ id: string }>(
    `insert into policy_rule
       (seq, subject_kind, subject_id, server_id, item_kind, name_pattern, effect, args, note, expires_at)
     values (coalesce($1, (select coalesce(max(seq), 0) + 10 from policy_rule)),
             $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [
      p.seq,
      p.subject.kind,
      p.subject.kind === 'any' ? null : p.subject.id,
      serverId,
      p.kind,
      p.pattern,
      p.effect,
      JSON.stringify(p.args),
      p.note,
      p.expiresAt,
    ],
  );
  return r.rows[0]?.id as string;
}

/** Every enabled rule as one sentence, in evaluation order, with shadow warnings. */
export async function listPolicies(pool: pg.Pool): Promise<string[]> {
  const r = await pool.query<RuleRow & { serverSlug: string }>(
    `select p.id, p.seq, p.enabled, p.subject_kind as "subjectKind", p.subject_id as "subjectId",
            p.server_id as "serverId", s.slug as "serverSlug", p.item_kind as "itemKind",
            p.name_pattern as "namePattern", p.effect, p.args, p.note, p.expires_at as "expiresAt"
     from policy_rule p join servers s on s.id = p.server_id`,
  );
  const { rules, broken } = compileRules(r.rows);
  const now = Date.now();
  const lines = rules.map((rule) => {
    const flags = [
      broken.includes(rule.id) ? 'INVALID — enforced as deny' : null,
      rule.expiresAt !== null && rule.expiresAt <= now ? 'expired' : null,
    ].filter((x) => x !== null);
    return `${rule.id}  #${rule.seq}  ${describeRule(rule)}${flags.length > 0 ? `  [${flags.join(', ')}]` : ''}`;
  });
  for (const s of findShadows(rules)) {
    const when =
      s.until === null ? 'never matches' : `cannot match until ${new Date(s.until).toISOString()}`;
    lines.push(`WARNING: ${s.shadowed} ${when} — ${s.by} above it matches everything it would.`);
  }
  return lines;
}

export async function removePolicy(pool: pg.Pool, id: string): Promise<void> {
  const r = await pool.query('delete from policy_rule where id = $1', [id]);
  if (r.rowCount === 0) throw new OpError(404, `no policy rule ${id}`);
}
