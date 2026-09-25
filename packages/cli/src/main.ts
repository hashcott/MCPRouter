import { parseArgs } from 'node:util';
import { createDb, createLogger, createPool, createServer } from '@mcprouter/core';
import { createAuth, loadConfig } from '@mcprouter/server';
import {
  addGroup,
  addUser,
  CliError,
  createKey,
  parseGroupAdd,
  parseServerAdd,
  secretLines,
  setToolEnabled,
} from './commands.js';

const HELP = `mcprouter <command>

  secret                                      print a fresh AUTH_SECRET and MCPR_SECRET_KEYS
  users add --email <e> --name <n> [--role viewer|operator|admin]
  keys create --email <e> [--name <n>] [--group <g>]… | [--server <s>]…   print a new API key (shown once); neither: every server
  servers add <slug> --url <url> [--sse] [--header K=V | --header K]… [--allow-private-network] [--disabled]
  servers add <slug> [--env K=V | --env K]… [--cwd <dir>] -- <command> [args…]
  servers tool <server> <tool> --enable | --disable
  groups add <slug> [--server <slug>[=tool,tool]]…   --server s=a,b selects ONLY those tools

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
      if (values.email === undefined || values.name === undefined)
        throw new CliError('--email and --name are required');
      if (role !== 'viewer' && role !== 'operator' && role !== 'admin')
        throw new CliError('--role must be viewer, operator or admin');
      process.stdout.write(
        `${await addUser(pool, { email: values.email, name: values.name, role })}\n`,
      );
    } else if (cmd === 'keys' && sub === 'create') {
      const { values } = parseArgs({
        args: rest,
        options: {
          email: { type: 'string' },
          name: { type: 'string', default: 'cli' },
          group: { type: 'string', multiple: true, default: [] },
          server: { type: 'string', multiple: true, default: [] },
        },
      });
      if (values.email === undefined) throw new CliError('--email is required');
      const log = createLogger({ level: 'warn', file: undefined, pretty: false });
      const auth = createAuth({
        db,
        secret: config.authSecret,
        baseURL: config.publicUrl.href,
        log,
      });
      process.stdout.write(
        `${await createKey(auth, pool, {
          email: values.email,
          name: values.name,
          groups: values.group,
          servers: values.server,
        })}\n`,
      );
    } else if (cmd === 'servers' && sub === 'add') {
      const input = parseServerAdd(rest, process.env);
      process.stdout.write(`${await createServer(db, config.secretKeys, input)}\n`);
    } else if (cmd === 'groups' && sub === 'add') {
      process.stdout.write(`${await addGroup(pool, parseGroupAdd(rest))}\n`);
    } else if (cmd === 'servers' && sub === 'tool') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          enable: { type: 'boolean', default: false },
          disable: { type: 'boolean', default: false },
        },
      });
      const [server, tool] = positionals;
      if (server === undefined || tool === undefined || values.enable === values.disable) {
        throw new CliError('usage: mcprouter servers tool <server> <tool> --enable | --disable');
      }
      await setToolEnabled(pool, { server, tool, enabled: values.enable });
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
