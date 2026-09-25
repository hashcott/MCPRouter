import { randomUUID } from 'node:crypto';
import type { Bus, EngineEvents } from './bus.js';
import { resolveByKind, resolveTool } from './catalog.js';
import { PayloadTooLargeError, UpstreamUnavailableError, redact } from './errors.js';
import type { ServerRegistry } from './registry.js';
import type { MiniLogger } from './upstream-server.js';
import type { Principal, ResolvedScope, ServerSelection } from './types.js';

/** Ruling P13: a missing, non-numeric or non-positive value must not disable the cap. */
function maxArgBytes(): number {
  const n = Number(process.env['MCPROUTER_MAX_ARG_BYTES']);
  return Number.isFinite(n) && n > 0 ? n : 1_048_576;
}

export type CallDeps = { reg: ServerRegistry; bus: Bus<EngineEvents>; logger: MiniLogger };

export type ToolDecision = { sel: ServerSelection; bare: string; server: string };

export type CallToolReq = {
  scope: ResolvedScope;
  principal: Principal;
  /** Downstream name: prefixed, aliased or flattened. */
  name: string;
  args: Record<string, unknown>;
  signal?: AbortSignal | undefined;
  onProgress?: ((p: { progress: number; total?: number; message?: string }) => void) | undefined;
  deadlineMs?: number | undefined;
  secrets?: readonly string[] | undefined;
};

/**
 * §11.4 seam, half one: WHICH tool, and may this scope reach it. Pure lookup —
 * no I/O. P2 inserts the policy gate between this and `callResolved`; neither
 * function changes when it does.
 */
export function resolveToolDecision(
  scope: ResolvedScope,
  reg: ServerRegistry,
  name: string,
): ToolDecision {
  const { sel, bare } = resolveTool(scope, reg, name);
  return { sel, bare, server: sel.serverName };
}

/**
 * True only when we can prove the request never reached the upstream (D11 /
 * Ruling P10): an `UpstreamUnavailableError` (thrown by `#requireClient`
 * before any send), the SDK's exact pre-send `Not connected` rejection, or a
 * `ENOTCONN`/`ECONNREFUSED` transport code. Deliberately does NOT match
 * `Connection closed` (the SDK's `Protocol._onclose` rejects every in-flight,
 * possibly-delivered response handler with that McpError), `ECONNRESET` or
 * `EPIPE` — those can arrive after bytes already left, and retrying them is
 * the double-executed write D11 exists to forbid.
 */
function neverDelivered(err: unknown): boolean {
  if (err instanceof UpstreamUnavailableError) return true;
  const e = err as { code?: unknown; message?: string };
  if (e.message === 'Not connected') return true;
  const code = String(e.code ?? '');
  return code === 'ENOTCONN' || code === 'ECONNREFUSED';
}

/**
 * §11.4 seam, half two: execute an already-authorized decision.
 *
 * The retry is gated on "did the request arrive", never on a status code. A
 * delivered call that failed has already run its side effect; retrying it is a
 * data-corruption bug wearing a resilience costume.
 */
export async function callResolved(
  deps: CallDeps,
  decision: ToolDecision,
  req: CallToolReq,
): Promise<unknown> {
  const callId = randomUUID();
  const started = Date.now();
  const size = Buffer.byteLength(JSON.stringify(req.args ?? {}), 'utf8');
  const cap = maxArgBytes();
  if (size > cap) {
    throw new PayloadTooLargeError(`Arguments too large: ${size} bytes (max ${cap})`);
  }

  deps.bus.emit('call:start', {
    callId,
    server: decision.server,
    kind: 'tool',
    target: decision.bare,
    principalId: req.principal.id,
    scopeKey: req.scope.key,
    args: req.args,
  });

  const opts = {
    ...(req.signal === undefined ? {} : { signal: req.signal }),
    ...(req.onProgress === undefined ? {} : { onProgress: req.onProgress }),
    ...(req.deadlineMs === undefined ? {} : { deadlineMs: req.deadlineMs }),
    ...(req.secrets === undefined ? {} : { secrets: req.secrets }),
  };

  // Ruling P11: lease + readiness live INSIDE the try, so a down server still
  // pairs its call:start with a call:end instead of leaking an unmatched start.
  try {
    const srv = await deps.reg.lease(decision.server, req.principal);
    await srv.ensureReady(req.deadlineMs);

    let result: unknown;
    try {
      result = await srv.callTool(decision.bare, req.args, opts);
    } catch (err) {
      if (!neverDelivered(err)) throw err;
      deps.logger.debug({ evt: 'call.retry', callId, server: decision.server });
      await srv.ensureReady(req.deadlineMs);
      result = await srv.callTool(decision.bare, req.args, opts);
    }
    const isError = (result as { isError?: boolean } | undefined)?.isError === true;
    deps.bus.emit('call:end', {
      callId,
      ok: true,
      isError,
      durationMs: Date.now() - started,
      result,
    });
    return result;
  } catch (err) {
    const e = redact(err instanceof Error ? err : new Error(String(err)), req.secrets ?? []);
    deps.bus.emit('call:end', {
      callId,
      ok: false,
      isError: true,
      durationMs: Date.now() - started,
      errorCode: String((e as { code?: string }).code ?? 'ERROR'),
    });
    throw e;
  }
}

/** The composition. Nothing else may call an upstream tool. */
export async function callTool(deps: CallDeps, req: CallToolReq): Promise<unknown> {
  let decision: ToolDecision;
  try {
    decision = resolveToolDecision(req.scope, deps.reg, req.name);
  } catch (err) {
    deps.bus.emit('call:end', {
      callId: randomUUID(),
      ok: false,
      isError: true,
      durationMs: 0,
      errorCode: 'TOOL_UNAVAILABLE',
    });
    throw err;
  }
  return callResolved(deps, decision, req);
}

/**
 * Ruling P12: a prompt resolves through the SAME predicate as a tool — by its
 * projected name — so a hidden tool's name cannot leak a prompt.
 */
export async function getPrompt(deps: CallDeps, req: CallToolReq): Promise<unknown> {
  const { sel, bare } = resolveByKind(req.scope, deps.reg, 'prompt', req.name);
  try {
    const srv = await deps.reg.lease(sel.serverName, req.principal);
    await srv.ensureReady(req.deadlineMs);
    return await srv.getPrompt(bare, req.args, {
      ...(req.signal === undefined ? {} : { signal: req.signal }),
      ...(req.onProgress === undefined ? {} : { onProgress: req.onProgress }),
      ...(req.deadlineMs === undefined ? {} : { deadlineMs: req.deadlineMs }),
      ...(req.secrets === undefined ? {} : { secrets: req.secrets }),
    });
  } catch (err) {
    throw redact(err instanceof Error ? err : new Error(String(err)), req.secrets ?? []);
  }
}

export type ReadResourceReq = {
  scope: ResolvedScope;
  principal: Principal;
  uri: string;
  secrets?: readonly string[] | undefined;
  signal?: AbortSignal | undefined;
  deadlineMs?: number | undefined;
};

/**
 * Ruling P12: resources are not prefixed and take no caller-supplied server —
 * the resolver scans `scope.servers` in order and reads from the first server
 * whose predicate allows this URI, so a URI hidden from `listResources` can
 * never be read, and a server outside scope can never be reached.
 */
export async function readResource(deps: CallDeps, req: ReadResourceReq): Promise<unknown> {
  const { sel, bare } = resolveByKind(req.scope, deps.reg, 'resource', req.uri);
  try {
    const srv = await deps.reg.lease(sel.serverName, req.principal);
    await srv.ensureReady(req.deadlineMs);
    return await srv.readResource(bare, {
      ...(req.signal === undefined ? {} : { signal: req.signal }),
      ...(req.deadlineMs === undefined ? {} : { deadlineMs: req.deadlineMs }),
      ...(req.secrets === undefined ? {} : { secrets: req.secrets }),
    });
  } catch (err) {
    throw redact(err instanceof Error ? err : new Error(String(err)), req.secrets ?? []);
  }
}
