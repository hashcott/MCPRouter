export const VERSION = '0.0.0';

export {
  currentContext,
  newRequestId,
  runWithContext,
  type RequestContext,
} from './obs/context.js';
export { createLogger, redactServerConfig, type Logger, type LoggerOptions } from './obs/log.js';
export { createDb, createPool, runMigrations, MIGRATION_LOCK_ID, type Db } from './db/migrate.js';
export { schema, type Schema } from './db/schema/index.js';
export type { Outcome, Selection } from './db/schema/index.js';
export { generateKeyLine, KeyringError, parseKeyring, type Keyring } from './security/seal.js';
export { createServer, loadServerConfigs, type LoadedServers, type NewServer } from './db/store.js';
export { PlainServerConfig, type PlainServerConfigInput } from './db/server-config.js';

export { Engine, type EngineOptions } from './engine.js';
export { Bus, type EngineEvents } from './bus.js';
export {
  callResolved,
  callTool,
  getPrompt,
  readResource,
  resolveToolDecision,
  type CallDeps,
  type CallToolReq,
  type ReadResourceReq,
  type ToolDecision,
} from './call.js';
export {
  explainTool,
  exposure,
  INTEGRITY_BLOCKS,
  isExposed,
  label,
  project,
  projectTools,
  resolveTool,
  type Exposure,
} from './catalog.js';
export { canonical, hashDefinition, type DefHashes } from './guardrails/hash.js';
export { createTransport, type TransportCtx, type TransportFactory } from './transport.js';
export { assertSafeUrl, guardedFetch, isBlockedIp } from './ssrf.js';
export {
  CredentialsRequiredError,
  PayloadTooLargeError,
  ToolUnavailableError,
  UnsafeUrlError,
  UpstreamAuthRequiredError,
  UpstreamBusyError,
  UpstreamUnavailableError,
  redact,
} from './errors.js';
export { reviewKey, SEP } from './types.js';
export type {
  CallOpts,
  CredentialResolver,
  Integrity,
  IntegrityMode,
  ItemDef,
  ItemKind,
  Principal,
  Prompt,
  ResolvedScope,
  Resource,
  ResourceTemplate,
  Review,
  ReviewState,
  ServerCatalog,
  ServerConfig,
  ServerSelection,
  ServerStatus,
  Tool,
} from './types.js';
