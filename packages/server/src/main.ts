import { serve } from '@hono/node-server';
import { createLogger, createPool, runMigrations } from '@mcprouter/core';
import { loadConfig } from './config.js';
import { createApp, type Readiness } from './app.js';
import { createRegistry } from './metrics.js';

const config = loadConfig();
const log = createLogger({
  level: config.logLevel,
  file: config.logFile,
  pretty: process.env['NODE_ENV'] !== 'production',
});

const pool = createPool(config.databaseUrl);
const registry = createRegistry();
const readiness: Readiness = { migrationsApplied: false, routesMounted: false };
const app = createApp({ config, log, pool, registry, readiness });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  readiness.routesMounted = true;
  log.info({ evt: 'boot.listening', port: info.port }, 'listening');
});

if (config.migrateOnBoot) {
  try {
    await runMigrations(pool, log);
    readiness.migrationsApplied = true;
  } catch (err) {
    log.fatal({ evt: 'boot.migrate_failed', err }, 'migrations failed');
    process.exit(1);
  }
} else {
  readiness.migrationsApplied = true;
  log.warn({ evt: 'boot.migrate_skipped' }, 'MIGRATE_ON_BOOT=false');
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ evt: 'shutdown.begin', signal }, 'shutting down');
  const timer = setTimeout(() => {
    log.warn({ evt: 'shutdown.timeout' }, 'forcing exit');
    process.exit(0);
  }, config.shutdownTimeoutMs);
  timer.unref();
  server.close();
  await pool.end();
  log.info({ evt: 'shutdown.done' }, 'bye');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
