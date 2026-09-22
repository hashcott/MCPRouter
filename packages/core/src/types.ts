import type {
  Prompt,
  Resource,
  ResourceTemplate,
  ServerCapabilities,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

export type { Prompt, Resource, ResourceTemplate, ServerCapabilities, Tool };

/** Not configurable. A server name containing this is rejected at the schema boundary (D6). */
export const SEP = '__';

export type ServerSelection = {
  serverName: string;
  /** Renames the server on this route only. */
  alias?: string;
  /** BARE upstream names, never prefixed. */
  tools: 'all' | string[];
  prompts: 'all' | string[];
  resources: 'all' | string[];
};

export type ResolvedScope = {
  /** Stable memo key. MUST be a pure function of the fields below. packages/server computes it. */
  key: string;
  /** Already authorized. Core does NO authz. An empty array means an empty catalog, never 'all'. */
  servers: ServerSelection[];
  /** Single-server route: strip the `<server>__` prefix. Set only when servers.length === 1. */
  flatten: boolean;
};

export interface CredentialResolver {
  /** Returns {} when this principal has no binding for this server. Never throws for 'missing'. */
  resolveHeaders(serverName: string): Promise<Record<string, string>>;
  /** Opaque; changes when the underlying binding changes. Used as the connection key suffix. */
  revision(serverName: string): string;
}

export type Principal = {
  /** User id, or the api-key owner's user id. */
  id: string;
  isAdmin: boolean;
  /** Present ONLY when this auth path is permitted to use per-user secrets. */
  credentials?: CredentialResolver | undefined;
};

export type ServerConfigBase = {
  name: string;
  enabled: boolean;
  credentialMode: 'shared' | 'per-user';
  /** Keys are BARE upstream tool names. Core rejects any key containing SEP. */
  tools?: Record<string, { enabled?: boolean; description?: string }> | undefined;
  timeouts?: { connectMs?: number; requestMs?: number } | undefined;
  maxConcurrentCalls?: number | undefined;
};

export type ServerConfig = ServerConfigBase &
  (
    | {
        type: 'stdio';
        command: string;
        args?: string[] | undefined;
        env?: Record<string, string> | undefined;
        cwd?: string | undefined;
      }
    | {
        type: 'streamable-http' | 'sse';
        url: string;
        headers?: Record<string, string> | undefined;
        /** Explicit, audited SSRF escape hatch. There is NO owner-based bypass (D12). */
        allowPrivateNetwork?: boolean | undefined;
      }
  );

export type ServerCatalog = {
  /** Keyed by BARE name. Descriptions are already overridden at cache time. */
  tools: ReadonlyMap<string, Tool>;
  prompts: ReadonlyMap<string, Prompt>;
  resources: readonly Resource[];
  resourceTemplates: readonly ResourceTemplate[];
  capabilities: ServerCapabilities;
  instructions?: string | undefined;
  fetchedAt: number;
  /** Drives the server:catalog{changed} flag. */
  namesHash: string;
};

export type ServerStatus = {
  name: string;
  state: string;
  stale: boolean;
  toolCount: number;
  lastError?: string | undefined;
  attempt: number;
  stderrTail: readonly string[];
};

export type CallOpts = {
  signal?: AbortSignal | undefined;
  onProgress?: ((p: { progress: number; total?: number; message?: string }) => void) | undefined;
  deadlineMs?: number | undefined;
  /** Resolved credential values, passed so redact() can strip them from any thrown error. */
  secrets?: readonly string[] | undefined;
};
