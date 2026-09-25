import { VERSION } from '@mcprouter/core';

export function describe(): string {
  return `mcprouter ${VERSION}`;
}

export { createApp, type AppDeps, type McpDeps } from './app.js';
export { authenticateKey, createAuth, KEY_GRANT_ALL, type Auth, type KeyAuth } from './auth.js';
export { loadConfig, parseConfig, type Config } from './config.js';
export { createRegistry } from './metrics.js';
export { startServerSync, type ServerSync } from './servers-sync.js';
export { checkGrant, parseGrant, toPermissions, type Grant } from './grant.js';
export { EMPTY_SNAPSHOT, resolveTarget, type Route, type Snapshot, type Target } from './scope.js';
