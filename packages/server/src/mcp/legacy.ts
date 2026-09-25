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
  ToolUnavailableError,
  VERSION,
  type Engine,
  type Principal,
  type ResolvedScope,
} from '@mcprouter/core';

export type McpCall = {
  engine: Engine;
  scope: ResolvedScope;
  principal: Principal;
  timeoutMs: number;
};

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
export async function handleMcp(req: Request, call: McpCall): Promise<Response> {
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
    try {
      return (await engine.callTool({
        scope,
        principal,
        name: r.params.name,
        args: r.params.arguments ?? {},
        signal,
      })) as CallToolResult;
    } catch (err) {
      if (err instanceof ToolUnavailableError) notFound(err);
      // An upstream failure is the tool's result, not the gateway's: the model sees it.
      const text = err instanceof Error ? err.message : 'tool call failed';
      return { content: [{ type: 'text', text }], isError: true };
    }
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: await engine.listPrompts(scope, principal),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (r) => {
    try {
      return (await engine.getPrompt({
        scope,
        principal,
        name: r.params.name,
        args: r.params.arguments ?? {},
        signal,
      })) as GetPromptResult;
    } catch (err) {
      return notFound(err);
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: await engine.listResources(scope, principal),
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: await engine.listResourceTemplates(scope, principal),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (r) => {
    try {
      return (await engine.readResource({
        scope,
        principal,
        uri: r.params.uri,
        signal,
      })) as ReadResourceResult;
    } catch (err) {
      return notFound(err);
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
