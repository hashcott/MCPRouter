import { VERSION } from '@mcprouter/core';

export function describe(): string {
  return `mcprouter ${VERSION}`;
}

export { createApp, type AppDeps, type AuditRow, type McpDeps } from './app.js';
export { AuditWriter } from './audit.js';
export { authenticateKey, createAuth, KEY_GRANT_ALL, type Auth, type KeyAuth } from './auth.js';
export { loadConfig, parseConfig, type Config } from './config.js';
export { createRegistry } from './metrics.js';
export { startServerSync, type ServerSync } from './servers-sync.js';
export { canSee, checkGrant, parseGrant, toPermissions, type Grant } from './grant.js';
export { EMPTY_SNAPSHOT, resolveTarget, type Route, type Snapshot, type Target } from './scope.js';
export { startTruthWriter } from './integrity.js';
export { ALLOW_ALL_GATE, denyText, makeGate, type Gate, type GateResult } from './gate.js';
export {
  ArgConstraint,
  ArgConstraints,
  compileRules,
  describeRule,
  evaluate,
  findShadows,
  globMatch,
  pathUnder,
  pointerGet,
  ROLES,
  type CompiledRule,
  type PolicyDecision,
  type PolicySubject,
  type Role,
  type RuleRow,
} from './policy.js';
