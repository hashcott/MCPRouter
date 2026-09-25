import { VERSION } from '@mcprouter/core';

export function describe(): string {
  return `mcprouter ${VERSION}`;
}

export { createApp, type AppDeps, type McpDeps } from './app.js';
export { authenticateKey, createAuth, KEY_GRANT_ALL, type Auth } from './auth.js';
export { loadConfig, parseConfig, type Config } from './config.js';
export { createRegistry } from './metrics.js';
export { EMPTY_SCOPE, startServerSync, type ServerSync } from './servers-sync.js';
