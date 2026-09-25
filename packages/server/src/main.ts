import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createDb, createLogger, createPool, Engine, runMigrations } from '@mcprouter/core';
import { AuditWriter } from './audit.js';
import { authenticateKey, createAuth } from './auth.js';
import { loadConfig } from './config.js';
import { createApp, type Readiness } from './app.js';
import { createRegistry } from './metrics.js';
import { EMPTY_SNAPSHOT, resolveTarget } from './scope.js';
import { startServerSync, type ServerSync } from './servers-sync.js';

const config = loadConfig();
const log = createLogger({
  level: config.logLevel,
  file: config.logFile,
  pretty: process.env['NODE_ENV'] !== 'production',
});

const webRoot =
  process.env['WEB_ROOT'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

const pool = createPool(config.databaseUrl);
const db = createDb(pool);
const engine = new Engine({ logger: log });
const auth = createAuth({ db, secret: config.authSecret, baseURL: config.publicUrl.href, log });
const audit = new AuditWriter({ db, log });
audit.start();
let sync: ServerSync | undefined;
const registry = createRegistry();
const readiness: Readiness = { migrationsApplied: false, routesMounted: false };
const app = createApp({
  config,
  log,
  pool,
  registry,
  readiness,
  webRoot,
  mcp: {
    authenticate: (header) => authenticateKey(auth, header),
    engine,
    // Before the first sync lands, an empty snapshot — never "all" (P1a constraint).
    resolve: (t) => resolveTarget(sync?.snapshot() ?? EMPTY_SNAPSHOT, t),
    timeoutMs: config.mcpCallTimeoutMs,
    maxInflight: config.maxInflight,
    audit: (row) => audit.push(row),
    authHandler: (req) => auth.handler(req),
  },
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  readiness.routesMounted = true;
  log.info({ evt: 'boot.listening', port: info.port }, 'listening');
});

if (config.migrateOnBoot) {
  try {
    await runMigrations(pool, log, process.env['MIGRATIONS_DIR']);
    readiness.migrationsApplied = true;
  } catch (err) {
    log.fatal({ evt: 'boot.migrate_failed', err }, 'migrations failed');
    process.exit(1);
  }
} else {
  readiness.migrationsApplied = true;
  log.warn({ evt: 'boot.migrate_skipped' }, 'MIGRATE_ON_BOOT=false');
}

sync = await startServerSync({ pool, db, keyring: config.secretKeys, engine, log });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ evt: 'shutdown.begin', signal }, 'shutting down');
  const timer = setTimeout(() => {
    log.warn({ evt: 'shutdown.timeout' }, 'forcing exit');
    // Audit rows still queued or in flight go to the log, never nowhere (§8).
    audit.spillAll();
    process.exit(0);
  }, config.shutdownTimeoutMs);
  timer.unref();
  // Drain: in-flight tool calls finish before their upstreams are stopped.
  // The timer above caps the wait at SHUTDOWN_TIMEOUT_MS.
  await new Promise<void>((done) => server.close(() => done()));
  await audit.stop();
  sync?.stop();
  await engine.shutdown();
  await pool.end();
  log.info({ evt: 'shutdown.done' }, 'bye');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
