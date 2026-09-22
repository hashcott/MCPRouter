import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Bus, EngineEvents } from './bus.js';
import { UpstreamAuthRequiredError, UpstreamUnavailableError } from './errors.js';
import type { Semaphore } from './semaphore.js';
import { next, type Ev, type State } from './state.js';
import type { TransportFactory } from './transport.js';
import type {
  CallOpts,
  Prompt,
  Resource,
  ResourceTemplate,
  ServerCapabilities,
  ServerCatalog,
  ServerConfig,
  Tool,
} from './types.js';

const STDERR_RING = 200;

export type MiniLogger = {
  debug: (o: unknown, m?: string) => void;
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
};

/** Injectable so a retry test runs in milliseconds instead of waiting on real backoff. */
export type RetryPolicy = { baseMs?: number; maxMs?: number; maxAttempts?: number };

export type UpstreamServerOpts = {
  config: ServerConfig;
  /** `${name}` for the shared instance, `${name}#${principalId}:${revision}` per-user. */
  key: string;
  bus: Bus<EngineEvents>;
  connect: TransportFactory;
  connectSem: Semaphore;
  logger: MiniLogger;
  /** Extra headers for a per-user instance. */
  headers?: Record<string, string>;
  retry?: RetryPolicy;
};

/** Stable across key order, so a cosmetic config rewrite does not restart a server. */
export function configHashOf(cfg: ServerConfig): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, canon(val)]),
      );
    }
    return v;
  };
  return createHash('sha256')
    .update(JSON.stringify(canon(cfg)))
    .digest('hex');
}

/** Errors we must never retry: retrying cannot change the answer. */
function isPermanent(err: unknown): boolean {
  const e = err as { permanent?: boolean; code?: unknown; message?: string };
  if (typeof e.permanent === 'boolean') return e.permanent;
  const code = String(e.code ?? '');
  if (['ENOENT', 'EACCES', 'ENOTDIR', 'ENOTFOUND', 'UNSAFE_URL'].includes(code)) return true;
  if (code === '404') return true;
  return /Unsupported scheme|non-public address|Unresolved value for/.test(e.message ?? '');
}

function isAuthChallenge(err: unknown): boolean {
  const e = err as { code?: unknown; message?: string };
  return String(e.code ?? '') === '401' || /unauthor/i.test(e.message ?? '');
}

export class UpstreamServer {
  readonly key: string;
  readonly name: string;
  readonly config: ServerConfig;
  readonly configHash: string;

  #state: State;
  #intent: State = 'closed';
  #catalog: ServerCatalog | undefined;
  #stale = false;
  #attempt = 0;
  #lastError: Error | undefined;
  #epoch = 0;
  #client: Client | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopping: Promise<void> | undefined;
  readonly #stderr: string[] = [];
  readonly #o: UpstreamServerOpts;
  readonly #retry: Required<RetryPolicy>;

  constructor(o: UpstreamServerOpts) {
    this.#o = o;
    this.key = o.key;
    this.name = o.config.name;
    this.config = o.config;
    this.configHash = configHashOf(o.config);
    this.#state = o.config.enabled ? 'idle' : 'disabled';
    this.#retry = {
      baseMs: o.retry?.baseMs ?? Number(process.env['MCPROUTER_RETRY_BASE_MS'] ?? 1000),
      maxMs: o.retry?.maxMs ?? Number(process.env['MCPROUTER_RETRY_MAX_MS'] ?? 30_000),
      maxAttempts: o.retry?.maxAttempts ?? Number(process.env['MCPROUTER_RETRY_MAX_ATTEMPTS'] ?? 0),
    };
  }

  get state(): State {
    return this.#state;
  }
  get catalog(): ServerCatalog | undefined {
    return this.#catalog;
  }
  /** A ready catalog being served while we reconnect underneath (D14). */
  get stale(): boolean {
    return this.#stale;
  }
  get attempt(): number {
    return this.#attempt;
  }
  get lastError(): Error | undefined {
    return this.#lastError;
  }
  get stderrTail(): readonly string[] {
    return this.#stderr;
  }
  /** True only when a request can actually be written to the upstream. */
  get connected(): boolean {
    return this.#client !== undefined && this.#state === 'ready';
  }

  /** Exposed for the ring-buffer test; the transport calls this via onStderr. */
  pushStderrForTest(line: string): void {
    this.#pushStderr(line);
  }

  #pushStderr(line: string): void {
    this.#stderr.push(line);
    while (this.#stderr.length > STDERR_RING) this.#stderr.shift();
    this.#o.bus.emit('upstream:log', {
      name: this.name,
      stream: 'stderr',
      level: 'info',
      message: line,
    });
  }

  start(): void {
    this.#dispatch({ t: 'start' });
  }

  refresh(): void {
    this.#dispatch({ t: 'refresh' });
    void this.#discover(this.#epoch);
  }

  async ensureReady(deadlineMs = 30_000): Promise<void> {
    if (this.#state === 'ready') return;
    if (this.#state === 'failed' || this.#state === 'disabled' || this.#state === 'closed') {
      throw new UpstreamUnavailableError(this.name, this.#state, this.#lastError);
    }
    if (this.#state === 'authRequired') throw new UpstreamAuthRequiredError(this.name);
    if (this.#state === 'idle') this.start();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new UpstreamUnavailableError(this.name, this.#state, this.#lastError));
      }, deadlineMs);
      timer.unref?.();
      const off = this.#o.bus.on('server:state', (e) => {
        if (e.key !== this.key) return;
        if (e.to === 'ready') {
          clearTimeout(timer);
          off();
          resolve();
        } else if (e.to === 'failed' || e.to === 'disabled' || e.to === 'closed') {
          clearTimeout(timer);
          off();
          reject(new UpstreamUnavailableError(this.name, e.to, this.#lastError));
        } else if (e.to === 'authRequired') {
          clearTimeout(timer);
          off();
          reject(new UpstreamAuthRequiredError(this.name, e.authorizationUrl));
        }
      });
    });
  }

  /**
   * Ruling P4: `stopping` drops a second `stop`, so re-entry must join the
   * in-flight teardown instead of dispatching an event the table will discard.
   */
  stop(intent: 'closed' | 'disabled' | 'idle'): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping;
    if (this.#state === 'closed') return Promise.resolve();
    this.#intent = intent;
    this.#stopping = this.#teardown(intent).finally(() => {
      this.#stopping = undefined;
    });
    return this.#stopping;
  }

  async #teardown(intent: 'closed' | 'disabled' | 'idle'): Promise<void> {
    // Bump the epoch FIRST: every in-flight continuation must now be a no-op.
    this.#epoch += 1;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#dispatch({ t: 'stop', intent });
    const client = this.#client;
    this.#client = undefined;
    try {
      await client?.close();
    } catch {
      /* closing a dead transport is not an error */
    }
    this.#dispatch({ t: 'stopped' });
    // idle/failed/disabled go straight to their target, so `stop` may have been
    // accepted directly rather than via `stopping`.
    if (this.#state !== intent) this.#setState(intent);
  }

  // ---- the ONLY mutator of #state -------------------------------------------

  #dispatch(ev: Ev): void {
    const to = next(this.#state, ev, this.#intent);
    if (to === undefined) {
      this.#o.logger.debug({ evt: 'state.drop', key: this.key, state: this.#state, ev: ev.t });
      return;
    }
    if (ev.t === 'discoverOk') this.#swapCatalog(ev.catalog);
    if (ev.t === 'connectFail' || ev.t === 'discoverFail') this.#lastError = ev.err;
    this.#setState(to, ev);
    this.#onEnter(to);
  }

  #setState(to: State, ev?: Ev): void {
    const from = this.#state;
    if (from === to && to !== 'ready') return;
    this.#state = to;
    if (to === 'ready') this.#lastError = undefined;
    const last = this.#lastError;
    const error =
      last === undefined
        ? undefined
        : { code: String((last as { code?: string }).code ?? 'ERROR'), message: last.message };
    this.#o.bus.emit('server:state', {
      name: this.name,
      key: this.key,
      from,
      to,
      attempt: this.#attempt,
      ...(error === undefined ? {} : { error }),
      ...(ev?.t === 'authChallenge' && ev.authorizationUrl !== undefined
        ? { authorizationUrl: ev.authorizationUrl }
        : {}),
    });
  }

  #onEnter(to: State): void {
    switch (to) {
      case 'connecting':
        void this.#doConnect();
        return;
      case 'ready':
        this.#stale = false;
        this.#attempt = 0;
        return;
      case 'retrying':
        this.#stale = this.#catalog !== undefined;
        this.#scheduleBackoff();
        return;
      default:
        return;
    }
  }

  #scheduleBackoff(): void {
    this.#attempt += 1;
    if (this.#retry.maxAttempts > 0 && this.#attempt > this.#retry.maxAttempts) {
      this.#dispatch({ t: 'giveUp' });
      return;
    }
    const ceiling = Math.min(this.#retry.baseMs * 2 ** (this.#attempt - 1), this.#retry.maxMs);
    const delay = Math.random() * ceiling; // full jitter
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#dispatch({ t: 'backoffElapsed' }), delay);
    this.#timer.unref?.();
  }

  async #doConnect(): Promise<void> {
    this.#epoch += 1;
    const epoch = this.#epoch;
    const abort = new AbortController();

    try {
      const transport: Transport = await this.#o.connectSem.run(() =>
        this.#o.connect(this.config, {
          headers: this.#o.headers ?? {},
          signal: abort.signal,
          onStderr: (line) => this.#pushStderr(line),
        }),
      );
      // The identity guard: a config change or a stop superseded us while we waited.
      if (epoch !== this.#epoch) {
        await transport.close?.().catch(() => {});
        return;
      }
      const client = new Client({ name: 'mcprouter', version: '0.0.0' });
      client.onclose = () => {
        if (epoch !== this.#epoch) return;
        this.#dispatch({ t: 'transportClose' });
      };
      await client.connect(transport);
      if (epoch !== this.#epoch) {
        await client.close().catch(() => {});
        return;
      }
      this.#client = client;
      this.#dispatch({ t: 'connectOk' });
      await this.#discover(epoch);
    } catch (err) {
      if (epoch !== this.#epoch) return;
      const e = err instanceof Error ? err : new Error(String(err));
      if (isAuthChallenge(e)) {
        this.#dispatch({ t: 'authChallenge' });
        return;
      }
      this.#dispatch({ t: 'connectFail', err: e, permanent: isPermanent(e) });
    }
  }

  async #discover(epoch: number): Promise<void> {
    const client = this.#client;
    if (client === undefined) return;
    try {
      const caps: ServerCapabilities = client.getServerCapabilities() ?? {};
      const tools = caps.tools === undefined ? [] : (await client.listTools()).tools;
      const prompts = caps.prompts === undefined ? [] : (await client.listPrompts()).prompts;
      const resources =
        caps.resources === undefined ? [] : (await client.listResources()).resources;
      const templates =
        caps.resources === undefined
          ? []
          : (await client.listResourceTemplates()).resourceTemplates;
      if (epoch !== this.#epoch) return;

      this.#dispatch({
        t: 'discoverOk',
        catalog: this.#buildCatalog(tools, prompts, resources, templates, caps),
      });
    } catch (err) {
      if (epoch !== this.#epoch) return;
      const e = err instanceof Error ? err : new Error(String(err));
      this.#dispatch({ t: 'discoverFail', err: e, permanent: isPermanent(e) });
    }
  }

  /**
   * Description overrides are applied HERE, once, at cache time — so the projected
   * list, the context-cost figure and the P5 embedding text all see the same
   * effective description. Applying them at list time is how mcphub ends up
   * embedding the unedited upstream text.
   */
  #buildCatalog(
    tools: Tool[],
    prompts: Prompt[],
    resources: Resource[],
    resourceTemplates: ResourceTemplate[],
    capabilities: ServerCapabilities,
  ): ServerCatalog {
    const overrides = this.config.tools ?? {};
    const toolMap = new Map<string, Tool>(
      tools.map((t) => {
        const override = overrides[t.name]?.description;
        return [t.name, override === undefined ? t : { ...t, description: override }];
      }),
    );
    const names = [
      ...[...toolMap.keys()].sort(),
      ...prompts.map((p) => p.name).sort(),
      ...resources.map((r) => r.uri).sort(),
    ].join('\u001f');
    return {
      tools: toolMap,
      prompts: new Map(prompts.map((p) => [p.name, p])),
      resources,
      resourceTemplates,
      capabilities,
      fetchedAt: Date.now(),
      namesHash: createHash('sha256').update(names).digest('hex'),
    };
  }

  #swapCatalog(catalog: ServerCatalog): void {
    const changed = this.#catalog?.namesHash !== catalog.namesHash;
    // Single assignment: Node is single-threaded, so this is atomic. No lock.
    this.#catalog = catalog;
    this.#o.bus.emit('server:catalog', {
      name: this.name,
      changed,
      tools: catalog.tools.size,
      prompts: catalog.prompts.size,
      resources: catalog.resources.length,
      fetchedAt: catalog.fetchedAt,
    });
  }

  // ---- upstream calls --------------------------------------------------------

  #requireClient(): Client {
    if (this.#client === undefined || this.#state !== 'ready') {
      throw new UpstreamUnavailableError(this.name, this.#state, this.#lastError);
    }
    return this.#client;
  }

  async callTool(bare: string, args: unknown, o: CallOpts): Promise<unknown> {
    return this.#requireClient().callTool(
      { name: bare, arguments: (args ?? {}) as Record<string, unknown> },
      undefined,
      this.#reqOpts(o),
    );
  }

  async getPrompt(bare: string, args: unknown, o: CallOpts): Promise<unknown> {
    return this.#requireClient().getPrompt(
      { name: bare, arguments: (args ?? {}) as Record<string, string> },
      this.#reqOpts(o),
    );
  }

  async readResource(uri: string, o: CallOpts): Promise<unknown> {
    return this.#requireClient().readResource({ uri }, this.#reqOpts(o));
  }

  #reqOpts(o: CallOpts): Record<string, unknown> {
    return {
      ...(o.signal === undefined ? {} : { signal: o.signal }),
      ...(o.onProgress === undefined ? {} : { onprogress: o.onProgress }),
      timeout: o.deadlineMs ?? Number(process.env['MCPROUTER_REQUEST_TIMEOUT_MS'] ?? 60_000),
      resetTimeoutOnProgress: true,
    };
  }
}
