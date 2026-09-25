import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
  type GetPromptResult,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  INTEGRITY_BLOCKS,
  ToolUnavailableError,
  VERSION,
  type Engine,
  type Exposure,
  type ItemKind,
  type Outcome,
  type Principal,
  type ResolvedScope,
  type ToolDecision,
} from '@mcprouter/core';

export type CallRecord = {
  server: string | null;
  item: string;
  outcome: Outcome;
  durationMs: number;
  /** metadata mode (§8): argument key names and byte size, never values. */
  inputKeys: string[];
  inputBytes: number;
  /** The error's class name only, never its message. */
  error: string | null;
  /** Internal — why a name did not resolve. Never sent to the client. */
  reason?: Exposure | undefined;
};

export type McpCall = {
  engine: Engine;
  scope: ResolvedScope;
  principal: Principal;
  timeoutMs: number;
  /** §4.2: the largest result returned downstream. */
  resultMaxBytes: number;
  audit?: ((r: CallRecord) => void) | undefined;
};

/**
 * §4.2: a result larger than the cap becomes its text, truncated, with the spec's
 * marker — and the truncated result itself fits the cap, measured the way it goes on
 * the wire (JSON escaping included). Structured content cannot be cut meaningfully,
 * so it is dropped and the result flagged isError: an SDK client that cached an
 * outputSchema rejects a success without it.
 */
export function capResult(res: CallToolResult, maxBytes: number): CallToolResult {
  const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');
  const size = bytes(res);
  if (size <= maxBytes) return res;
  const text = res.content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
  const isError = res.structuredContent !== undefined ? true : res.isError;
  const build = (n: number): CallToolResult => ({
    ...(isError === undefined ? {} : { isError }),
    content: [
      {
        type: 'text',
        text: `${text.slice(0, n)}\n[mcprouter:truncated ${size - bytes(text.slice(0, n))} bytes]`,
      },
    ],
  });
  // Largest prefix whose serialized result fits — binary search, O(log n) stringifies.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(build(mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return build(lo);
}

/** Hidden, missing and disabled are one protocol error with core's one message. */
function notFound(err: unknown): never {
  if (err instanceof ToolUnavailableError) throw new McpError(ErrorCode.InvalidParams, err.message);
  throw err;
}

/**
 * The era adapter (§4.2): everything specific to legacy-era, stateless
 * Streamable HTTP lives in this file. A stateless transport serves exactly ONE
 * request, and `notifications/initialized` is already a second one — so the
 * Server and the transport are both built per request (spike 4).
 */
export async function handleMcp(original: Request, call: McpCall): Promise<Response> {
  // One POST is one message. A batch would hand every entry to the Server at once
  // and walk straight past the per-principal limit; MCP dropped batches in 2025-06-18.
  const body = await original.text();
  if (body.trimStart().startsWith('[')) {
    return Response.json(
      {
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Batch requests are not supported.' },
        id: null,
      },
      { status: 400 },
    );
  }
  const req = new Request(original.url, {
    method: original.method,
    headers: original.headers,
    body,
    signal: original.signal,
  });
  const { engine, scope, principal } = call;
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(call.timeoutMs)]);

  const server = new Server(
    { name: 'mcprouter', version: VERSION },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await engine.listTools(scope, principal),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    const started = Date.now();
    const args = r.params.arguments ?? {};
    const rec = {
      server: null as string | null,
      item: r.params.name,
      inputKeys: Object.keys(args),
      inputBytes: Buffer.byteLength(JSON.stringify(args), 'utf8'),
    };
    const done = (outcome: Outcome, error: string | null = null, reason?: Exposure): void =>
      call.audit?.({
        ...rec,
        outcome,
        durationMs: Date.now() - started,
        error,
        ...(reason === undefined ? {} : { reason }),
      });

    // §11.4: resolve and execute stay two steps — P2b's policy gate sits between them.
    let decision: ToolDecision;
    try {
      decision = engine.resolve(scope, r.params.name);
    } catch (err) {
      if (err instanceof ToolUnavailableError) {
        done('not_found', null, engine.explain(scope, r.params.name));
      }
      return notFound(err);
    }
    rec.server = decision.server;
    rec.item = decision.bare;
    try {
      const res = (await engine.callResolved(decision, {
        scope,
        principal,
        name: r.params.name,
        args,
        signal,
      })) as CallToolResult;
      done(res.isError === true ? 'error' : 'ok');
      return capResult(res, call.resultMaxBytes);
    } catch (err) {
      if (err instanceof ToolUnavailableError) {
        done('not_found');
        return notFound(err);
      }
      // An upstream failure is the tool's result, not the gateway's: the model sees it.
      const text = err instanceof Error ? err.message : 'tool call failed';
      // The model sees the text; the audit row keeps only the kind (§8 metadata mode) —
      // upstream messages routinely echo argument values back.
      const kind = err instanceof Error ? err.name : 'unknown';
      done(signal.aborted ? 'timeout' : 'error', kind);
      return { content: [{ type: 'text', text }], isError: true };
    }
  });
  /**
   * prompts/get and resources/read: an integrity block leaves an internal record
   * (§11.2 "every integrity block"); the client still gets only the plain not-found.
   */
  const blocked = (kind: ItemKind, name: string, err: unknown, started: number): never => {
    if (err instanceof ToolUnavailableError) {
      const reason = engine.explain(scope, name, kind);
      if (INTEGRITY_BLOCKS.has(reason)) {
        call.audit?.({
          server: null,
          item: name,
          outcome: 'not_found',
          durationMs: Date.now() - started,
          inputKeys: [],
          inputBytes: 0,
          error: null,
          reason,
        });
      }
    }
    return notFound(err);
  };

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: await engine.listPrompts(scope, principal),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (r) => {
    const started = Date.now();
    try {
      return (await engine.getPrompt({
        scope,
        principal,
        name: r.params.name,
        args: r.params.arguments ?? {},
        signal,
      })) as GetPromptResult;
    } catch (err) {
      return blocked('prompt', r.params.name, err, started);
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: await engine.listResources(scope, principal),
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: await engine.listResourceTemplates(scope, principal),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (r) => {
    const started = Date.now();
    try {
      return (await engine.readResource({
        scope,
        principal,
        uri: r.params.uri,
        signal,
      })) as ReadResourceResult;
    } catch (err) {
      return blocked('resource', r.params.uri, err, started);
    }
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    // sessionIdGenerator omitted = stateless: no Mcp-Session-Id. Written as `undefined` it
    // fails exactOptionalPropertyTypes (the SDK's options are not EOPT-clean, P1a ruling P6).
    // The only mode whose Response is fully buffered, so closing below cannot truncate it.
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req);
    const headers = new Headers(res.headers);
    headers.set('X-Accel-Buffering', 'no');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } finally {
    await transport.close();
    await server.close();
  }
}
