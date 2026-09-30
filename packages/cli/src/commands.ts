import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { generateKeyLine, type NewServer } from '@mcprouter/core';
import { ArgConstraint, ops, ROLES, type Auth, type PolicyAdd, type Role } from '@mcprouter/server';

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

/** The shared operations, with their errors as one-line CLI errors. */
const cli =
  <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
  async (...a: A): Promise<R> => {
    try {
      return await f(...a);
    } catch (err) {
      if (err instanceof ops.OpError) throw new CliError(err.message);
      throw err;
    }
  };

export const addUser = cli(ops.addUser);
export const addGroup = cli(ops.addGroup);
export const setToolEnabled = cli(ops.setToolEnabled);
export const listReviews = cli(ops.listReviews);
export const approveItem = cli(ops.approveItem);
export const rejectItem = cli(ops.rejectItem);
export const addPolicy = cli(ops.addPolicy);
export const listPolicies = cli(ops.listPolicies);
export const removePolicy = cli(ops.removePolicy);

/** The CLI mints for a user named by email; the key string is what it prints. */
export const createKey = cli(
  async (
    auth: Auth,
    pool: Parameters<typeof ops.createKey>[1],
    input: { email: string; name: string; groups?: string[]; servers?: string[] },
  ): Promise<string> =>
    (
      await ops.createKey(auth, pool, {
        owner: { email: input.email },
        name: input.name,
        ...(input.groups === undefined ? {} : { groups: input.groups }),
        ...(input.servers === undefined ? {} : { servers: input.servers }),
      })
    ).key,
);
