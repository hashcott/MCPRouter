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
  resolveTarget,
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
    parseServerAdd(
      ['demo', '--env', 'DEMO_TOKEN', '--cwd', CORE_DIR, '--', process.execPath, '-e', UPSTREAM],
      {
        DEMO_TOKEN: 's3cret-token',
      },
    ),
  );

  engine = new Engine({ logger: log });
  sync = await startServerSync({
    pool,
    db,
    keyring: config.secretKeys,
    engine,
    log,
    intervalMs: 200,
  });
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
      timeoutMs: 30_000,
      maxInflight: 8,
      audit: () => {},
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

  it('the same request with a wrong key is a 401 from auth, not some other failure', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer mcpr_wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    await expect(connect('mcpr_wrong')).rejects.toThrow();
  });
});
