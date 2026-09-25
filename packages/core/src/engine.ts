import { Bus, type EngineEvents } from './bus.js';
import {
  callResolved,
  callTool as callToolImpl,
  getPrompt as getPromptImpl,
  readResource as readResourceImpl,
  resolveToolDecision,
  type CallDeps,
  type CallToolReq,
  type ReadResourceReq,
  type ToolDecision,
} from './call.js';
import {
  projectPrompts,
  projectResourceTemplates,
  projectResources,
  projectTools,
} from './catalog.js';
import { ServerRegistry } from './registry.js';
import { createTransport, type TransportFactory } from './transport.js';
import type { MiniLogger } from './upstream-server.js';
import type {
  Principal,
  Prompt,
  ResolvedScope,
  Resource,
  ResourceTemplate,
  ServerCatalog,
  ServerConfig,
  ServerStatus,
  Tool,
} from './types.js';

export type EngineOptions = {
  logger: MiniLogger;
  /** Default: the real factory. THE TEST SEAM. */
  connect?: TransportFactory;
  connectConcurrency?: number;
};

/** The only object packages/server holds. Core does no authz and no config storage. */
export class Engine {
  readonly events: Bus<EngineEvents>;
  readonly #reg: ServerRegistry;
  readonly #deps: CallDeps;
  #down = false;

  constructor(opts: EngineOptions) {
    this.events = new Bus<EngineEvents>((err) =>
      opts.logger.warn({ evt: 'bus.listener_threw', err }),
    );
    this.#reg = new ServerRegistry({
      bus: this.events,
      connect: opts.connect ?? createTransport,
      logger: opts.logger,
      ...(opts.connectConcurrency === undefined
        ? {}
        : { connectConcurrency: opts.connectConcurrency }),
    });
    this.#deps = { reg: this.#reg, bus: this.events, logger: opts.logger };
  }

  /** Idempotent full-state diff. Safe to call on every config write. */
  async applyConfig(configs: ServerConfig[]): Promise<void> {
    await this.#reg.applyConfig(configs);
  }

  listTools(scope: ResolvedScope, _principal: Principal): Promise<Tool[]> {
    return Promise.resolve(projectTools(scope, this.#reg));
  }
  listPrompts(scope: ResolvedScope, _principal: Principal): Promise<Prompt[]> {
    return Promise.resolve(projectPrompts(scope, this.#reg));
  }
  listResources(scope: ResolvedScope, _principal: Principal): Promise<Resource[]> {
    return Promise.resolve(projectResources(scope, this.#reg));
  }
  listResourceTemplates(scope: ResolvedScope, _principal: Principal): Promise<ResourceTemplate[]> {
    return Promise.resolve(projectResourceTemplates(scope, this.#reg));
  }

  callTool(req: CallToolReq): Promise<unknown> {
    return callToolImpl(this.#deps, req);
  }

  /** §11.4: exposed so P2's policy gate can sit between resolve and execute. */
  resolve(scope: ResolvedScope, name: string): ToolDecision {
    return resolveToolDecision(scope, this.#reg, name);
  }
  callResolved(decision: ToolDecision, req: CallToolReq): Promise<unknown> {
    return callResolved(this.#deps, decision, req);
  }

  getPrompt(req: CallToolReq): Promise<unknown> {
    return getPromptImpl(this.#deps, req);
  }
  /** Ruling P12/P14: the resource's server is resolved from scope via isExposed, never caller-supplied. */
  readResource(req: ReadResourceReq): Promise<unknown> {
    return readResourceImpl(this.#deps, req);
  }

  /** Everything a dashboard needs. Cheap, synchronous, no upstream I/O. */
  status(): ServerStatus[] {
    return this.#reg.list().map((s) => ({
      name: s.name,
      state: s.state,
      stale: s.stale,
      toolCount: s.catalog?.tools.size ?? 0,
      ...(s.lastError === undefined ? {} : { lastError: s.lastError.message }),
      attempt: s.attempt,
      stderrTail: s.stderrTail,
    }));
  }

  catalog(serverName: string): ServerCatalog | undefined {
    return this.#reg.shared(serverName)?.catalog;
  }

  /** Operator action: force a reconnect and reset the attempt counter. */
  async reload(serverName: string): Promise<void> {
    const srv = this.#reg.shared(serverName);
    if (srv === undefined) return;
    await srv.stop('idle');
    srv.start();
  }

  async shutdown(): Promise<void> {
    if (this.#down) return;
    this.#down = true;
    await this.#reg.shutdown();
  }
}
