import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { TransportFactory } from '../src/transport.js';

export type FakeTool = {
  name: string;
  description?: string;
  handler?: (args: Record<string, unknown>) => Promise<string> | string;
};

export type FakePrompt = {
  name: string;
  description?: string;
  handler?: (args: Record<string, string>) => Promise<string> | string;
};

export type FakeResource = {
  uri: string;
  name?: string;
  handler?: () => Promise<string> | string;
};

export type FakeKnobs = {
  /** Delay before connect resolves, to exercise the connect semaphore. */
  connectDelayMs?: number;
  /** 'permanent' -> never retry; 'transient' -> retryable. */
  failConnect?: 'permanent' | 'transient' | undefined;
  /** Throw a 401-shaped error so the engine reaches authRequired. */
  authChallenge?: boolean;
  /** Undefined -> no `prompts` capability, same as before this option existed. */
  prompts?: FakePrompt[];
  /** Undefined -> no `resources` capability, same as before this option existed. */
  resources?: FakeResource[];
};

/**
 * A REAL MCP server over InMemoryTransport — no child process, no port, sub-ms.
 *
 * It uses the low-level `Server` with the SDK's own request schemas rather than
 * `McpServer.registerTool`, for two reasons: `registerTool`'s inputSchema is
 * zod-typed and zod is deliberately not reachable from packages/core, and the
 * raw handler receives `arguments` verbatim, which is what lets a test prove an
 * argument actually crossed the wire.
 */
export class FakeUpstream {
  #tools: FakeTool[];
  #connects = 0;
  #closed = false;
  #live: Server | undefined;

  constructor(
    readonly name: string,
    tools: FakeTool[] = [],
    readonly knobs: FakeKnobs = {},
  ) {
    this.#tools = tools;
  }

  get connects(): number {
    return this.#connects;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #build(): Server {
    const { prompts, resources } = this.knobs;
    const server = new Server(
      { name: this.name, version: '0.0.0' },
      {
        capabilities: {
          tools: { listChanged: true },
          ...(prompts === undefined ? {} : { prompts: {} }),
          ...(resources === undefined ? {} : { resources: {} }),
        },
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.#tools.map((t) => ({
        name: t.name,
        description: t.description ?? `fake ${t.name}`,
        inputSchema: { type: 'object' as const, properties: {} },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = this.#tools.find((t) => t.name === request.params.name);
      if (tool === undefined) throw new Error(`no such tool: ${request.params.name}`);
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      return {
        content: [
          {
            type: 'text' as const,
            text: tool.handler === undefined ? `${tool.name}:ok` : await tool.handler(args),
          },
        ],
      };
    });

    if (prompts !== undefined) {
      server.setRequestHandler(ListPromptsRequestSchema, () => ({
        prompts: prompts.map((p) => ({
          name: p.name,
          description: p.description ?? `fake ${p.name}`,
        })),
      }));
      server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const prompt = prompts.find((p) => p.name === request.params.name);
        if (prompt === undefined) throw new Error(`no such prompt: ${request.params.name}`);
        const args = (request.params.arguments ?? {}) as Record<string, string>;
        const text =
          prompt.handler === undefined ? `${prompt.name}:ok` : await prompt.handler(args);
        return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
      });
    }

    if (resources !== undefined) {
      server.setRequestHandler(ListResourcesRequestSchema, () => ({
        resources: resources.map((r) => ({ uri: r.uri, name: r.name ?? r.uri })),
      }));
      // No fake test registers a template; discovery still needs a handler to call.
      server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
        resourceTemplates: [],
      }));
      server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const resource = resources.find((r) => r.uri === request.params.uri);
        if (resource === undefined) throw new Error(`no such resource: ${request.params.uri}`);
        const text =
          resource.handler === undefined ? `${resource.uri}:ok` : await resource.handler();
        return { contents: [{ uri: resource.uri, text }] };
      });
    }

    return server;
  }

  /** Replace the tool set and announce it, to exercise listChanged handling. */
  setTools(tools: FakeTool[]): void {
    this.#tools = tools;
    void this.#live?.sendToolListChanged();
  }

  /** Kill the connection from the upstream side, to drive reconnect + backoff. */
  async drop(): Promise<void> {
    await this.#live?.close();
  }

  /** A fresh Server per connect: one Protocol instance cannot be reconnected. */
  async connect(): Promise<Transport> {
    this.#connects += 1;
    if (this.knobs.connectDelayMs !== undefined) {
      await new Promise((r) => setTimeout(r, this.knobs.connectDelayMs));
    }
    if (this.knobs.authChallenge === true) {
      throw Object.assign(new Error('Unauthorized'), { code: 401 });
    }
    if (this.knobs.failConnect !== undefined) {
      throw Object.assign(new Error(`fake ${this.knobs.failConnect} connect failure`), {
        permanent: this.knobs.failConnect === 'permanent',
      });
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = this.#build();
    await server.connect(serverSide);
    this.#live = server;

    const origClose = clientSide.close.bind(clientSide);
    clientSide.close = async () => {
      this.#closed = true;
      await origClose();
    };
    return clientSide;
  }
}

/** Drop-in replacement for `createTransport` in every engine test. */
export function fakeFactory(fakes: Record<string, FakeUpstream>): TransportFactory {
  return async (cfg) => {
    const fake = fakes[cfg.name];
    if (fake === undefined) throw new Error(`no fake upstream registered for ${cfg.name}`);
    return fake.connect();
  };
}
