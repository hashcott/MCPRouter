import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import type pg from 'pg';
import { generateKeyLine, type NewServer } from '@mcprouter/core';
import {
  ArgConstraint,
  compileRules,
  describeRule,
  findShadows,
  ROLES,
  toPermissions,
  type Auth,
  type Grant,
  type Role,
  type RuleRow,
} from '@mcprouter/server';

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
  if (slug === undefined)
    throw new CliError('usage: mcprouter servers add <slug> (--url <url> | -- <command> [args…])');
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
  const r = await pool.query<{ id: string }>('select id from "user" where email = $1', [
    input.email,
  ]);
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
  if (slug === undefined)
    throw new CliError('usage: mcprouter groups add <slug> [--server <slug>[=tool,tool]]…');
  const members = parsed.values.server.map((spec) => {
    const eq = spec.indexOf('=');
    if (eq < 0) return { server: spec, tools: 'all' as const };
    const tools = spec
      .slice(eq + 1)
      .split(',')
      .filter((t) => t.length > 0);
    if (tools.length === 0)
      throw new CliError(`--server ${spec}: name at least one tool after '='`);
    return { server: spec.slice(0, eq), tools };
  });
  return { slug, members };
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
      throw new CliError(`no ${table === 'servers' ? 'server' : 'group'} named ${s}`);
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
  if (!KINDS.has(k)) throw new CliError(`kind must be tool, prompt or resource — got ${k}`);
  return k as 'tool' | 'prompt' | 'resource';
}

/** What needs a human: never reviewed, changed since approval, rejected, or defective. */
export async function listReviews(
  pool: pg.Pool,
  input: { server?: string },
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
    .filter((x) => x.state !== 'approved')
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
  input: { server: string; kind: string; name: string; hash: string },
): Promise<void> {
  const r = await pool.query(
    `insert into server_item_override (server_id, kind, item_name, review_state, approved_hash, approved_def, approved_at)
     select te.server_id, te.kind, te.name, 'approved', te.def_hash, te.def, now()
     from tool_embedding te join servers s on s.id = te.server_id
     where s.slug = $1 and te.kind = $2 and te.name = $3 and te.def_hash = $4
     on conflict (server_id, kind, item_name) do update
       set review_state = 'approved', approved_hash = excluded.approved_hash,
           approved_def = excluded.approved_def, approved_at = now(), updated_at = now()`,
    [input.server, kindOf(input.kind), input.name, input.hash],
  );
  if (r.rowCount === 0) {
    throw new CliError(
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

/** `30m`, `2h`, `1d`, or an ISO timestamp. */
function parseExpiry(v: string, now = Date.now()): Date {
  const m = /^(\d+)([mhd])$/.exec(v);
  if (m !== null) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
    return new Date(now + Number(m[1]) * unit);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new CliError(`--expires: expected 30m, 2h, 1d or an ISO time — got ${v}`);
  return d;
}

/**
 * `op:/json/pointer[=value]` — present:/p · absent:/p · equals:/p=v · oneOf:/p=a,b ·
 * prefix:/p=v · pathUnder:/p=/tmp · maxLen:/p=100
 */
export function parseArgSpec(spec: string): ArgConstraint {
  const colon = spec.indexOf(':');
  if (colon < 0) throw new CliError(`--arg ${spec}: expected op:/pointer[=value]`);
  const op = spec.slice(0, colon);
  const rest = spec.slice(colon + 1);
  const eq = rest.indexOf('=');
  const ptr = eq < 0 ? rest : rest.slice(0, eq);
  const value = eq < 0 ? undefined : rest.slice(eq + 1);
  const raw =
    op === 'oneOf'
      ? { op, ptr, values: (value ?? '').split(',').filter((x) => x.length > 0) }
      : op === 'maxLen'
        ? { op, ptr, n: Number(value) }
        : value === undefined
          ? { op, ptr }
          : { op, ptr, value };
  const r = ArgConstraint.safeParse(raw);
  if (!r.success) throw new CliError(`--arg ${spec}: ${r.error.issues[0]?.message ?? 'invalid'}`);
  return r.data;
}

export function parsePolicyAdd(argv: string[], now = Date.now()): PolicyAdd {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        allow: { type: 'boolean', default: false },
        deny: { type: 'boolean', default: false },
        kind: { type: 'string', default: 'tool' },
        name: { type: 'string', default: '*' },
        role: { type: 'string' },
        key: { type: 'string' },
        arg: { type: 'string', multiple: true, default: [] },
        note: { type: 'string' },
        expires: { type: 'string' },
        seq: { type: 'string' },
      },
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;
  const [server] = positionals;
  if (server === undefined || values.allow === values.deny) {
    throw new CliError(
      'usage: mcprouter policy add <server> (--allow | --deny) [--name <pattern>] …',
    );
  }
  if (values.kind !== 'tool') {
    // §11.4: prompt/resource policy is deferred. A rule that is not enforced must not look
    // like one — refuse it rather than print a sentence the gateway does not honour.
    throw new CliError(
      '--kind: only tool rules are enforced in this version (prompts/resources: not yet)',
    );
  }
  if (!/^[A-Za-z0-9_*.:/-]{1,128}$/.test(values.name)) {
    throw new CliError('--name: letters, digits, _ . : / - and * only (no regex)');
  }
  if (values.role !== undefined && values.key !== undefined) {
    throw new CliError('a rule targets a role OR an API key, not both');
  }
  if (values.role !== undefined && !ROLES.includes(values.role as Role)) {
    throw new CliError('--role must be viewer, operator or admin');
  }
  const args = values.arg.map(parseArgSpec);
  if (values.deny && args.length > 0) {
    throw new CliError('--arg belongs on an --allow rule; a deny rule is unconditional');
  }
  if (values.note !== undefined && values.note.length > 200)
    throw new CliError('--note: at most 200 characters');
  const seq = values.seq === undefined ? null : Number(values.seq);
  if (seq !== null && (!Number.isInteger(seq) || seq < 0))
    throw new CliError('--seq must be a non-negative integer');
  return {
    server,
    effect: values.allow ? 'allow' : 'deny',
    kind: values.kind as PolicyAdd['kind'],
    pattern: values.name,
    subject:
      values.role !== undefined
        ? { kind: 'role', id: values.role }
        : values.key !== undefined
          ? { kind: 'api_key', id: values.key }
          : { kind: 'any' },
    args,
    note: values.note ?? null,
    expiresAt: values.expires === undefined ? null : parseExpiry(values.expires, now),
    seq,
  };
}

/** Appends at the end unless --seq is given: first match means position is meaning. */
export async function addPolicy(pool: pg.Pool, p: PolicyAdd): Promise<string> {
  const [serverId] = await idsOf(pool, 'servers', [p.server]);
  if (p.subject.kind === 'api_key') {
    // A typo'd key id would make a break-glass deny that matches nobody and looks active.
    const k = await pool.query('select 1 from apikey where id = $1', [p.subject.id]);
    if (k.rowCount === 0) throw new CliError(`no API key with id ${p.subject.id}`);
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
  if (r.rowCount === 0) throw new CliError(`no policy rule ${id}`);
}
