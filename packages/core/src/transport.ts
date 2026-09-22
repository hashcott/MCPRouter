import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { assertSafeUrl, guardedFetch } from './ssrf.js';
import type { ServerConfig } from './types.js';

export type TransportCtx = {
  /** Config headers already merged with any resolved per-user headers. */
  headers: Record<string, string>;
  authProvider?: OAuthClientProvider | undefined;
  /** Aborted when stop() lands mid-connect. */
  signal: AbortSignal;
  onStderr: (line: string) => void;
};

export type TransportFactory = (cfg: ServerConfig, ctx: TransportCtx) => Promise<Transport>;

/** Paths a GUI-launched or container process routinely lacks but npx/uvx live in. */
const EXTRA_PATHS = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];

export function augmentPath(env: Record<string, string>): Record<string, string> {
  const current = (env['PATH'] ?? '').split(':').filter((p) => p.length > 0);
  for (const p of EXTRA_PATHS) if (!current.includes(p)) current.push(p);
  return { ...env, PATH: current.join(':') };
}

/**
 * Ruling P2: values are passed through VERBATIM. There is no variable expansion,
 * because expanding from process.env is exactly how a secret ends up inside a
 * config file (spec 5.4).
 *
 * Ruling P3: a non-string value means an unresolved secret reference reached the
 * transport. Stringifying it would spawn the upstream with the literal text
 * `[object Object]` as its token — a server that connects but is silently
 * unauthenticated. Fail closed and name the key instead.
 */
export function assertPlainStringMap(
  label: string,
  m: Record<string, unknown> | undefined,
): Record<string, string> {
  if (m === undefined) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v !== 'string') {
      throw new TypeError(
        `Unresolved value for ${label}.${k}: expected a string, got ${typeof v}. ` +
          'A secret reference must be resolved before it reaches the transport.',
      );
    }
    out[k] = v;
  }
  return out;
}

/**
 * The SDK's `Transport` interface declares one optional `string` property that
 * its own concrete transports expose as a getter typed `string | undefined`.
 * Those two disagree ONLY under `exactOptionalPropertyTypes`, which the SDK is
 * not compiled with — the objects are structurally correct in every way we use
 * them. This is the single boundary where we say so, rather than dropping a
 * compiler flag across the whole repo to accommodate one upstream declaration.
 */
function asTransport(
  t: SSEClientTransport | StdioClientTransport | StreamableHTTPClientTransport,
): Transport {
  return t as Transport;
}

export const createTransport: TransportFactory = async (cfg, ctx) => {
  switch (cfg.type) {
    case 'stdio': {
      const childEnv = assertPlainStringMap('env', cfg.env);
      return asTransport(
        new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env: { ...augmentPath(getDefaultEnvironment()), ...childEnv },
          ...(cfg.cwd === undefined ? {} : { cwd: cfg.cwd }),
          stderr: 'pipe',
        }),
      );
    }
    case 'streamable-http': {
      await assertSafeUrl(cfg.url, cfg.allowPrivateNetwork);
      const headers = { ...assertPlainStringMap('headers', cfg.headers), ...ctx.headers };
      return asTransport(
        new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: { headers },
          ...(ctx.authProvider === undefined ? {} : { authProvider: ctx.authProvider }),
          fetch: guardedFetch(cfg.allowPrivateNetwork),
        }),
      );
    }
    case 'sse': {
      await assertSafeUrl(cfg.url, cfg.allowPrivateNetwork);
      const headers = { ...assertPlainStringMap('headers', cfg.headers), ...ctx.headers };
      return asTransport(
        new SSEClientTransport(new URL(cfg.url), {
          requestInit: { headers },
          ...(ctx.authProvider === undefined ? {} : { authProvider: ctx.authProvider }),
          fetch: guardedFetch(cfg.allowPrivateNetwork),
        }),
      );
    }
  }
};
