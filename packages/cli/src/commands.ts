import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import type pg from 'pg';
import { generateKeyLine, type NewServer } from '@mcprouter/core';
import { toPermissions, type Auth, type Grant } from '@mcprouter/server';

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
