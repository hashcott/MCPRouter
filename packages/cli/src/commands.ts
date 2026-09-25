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

/** R3: in P1 the CLI is the only minter and `all` the only grant. P2 moves minting to POST /api/keys. */
export async function createKey(
  auth: Auth,
  pool: pg.Pool,
  input: { email: string; name: string },
): Promise<string> {
  const r = await pool.query<{ id: string }>('select id from "user" where email = $1', [
    input.email,
  ]);
  const userId = r.rows[0]?.id;
  if (userId === undefined) {
    throw new CliError(`no user with email ${input.email} — run \`mcprouter users add\` first`);
  }
  const k = await auth.api.createApiKey({
    body: { name: input.name, userId, permissions: KEY_GRANT_ALL },
  });
  return k.key;
}
