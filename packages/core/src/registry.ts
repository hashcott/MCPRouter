import type { Bus, EngineEvents } from './bus.js';
import { CredentialsRequiredError } from './errors.js';
import { Semaphore } from './semaphore.js';
import type { TransportFactory } from './transport.js';
import {
  UpstreamServer,
  configHashOf,
  type MiniLogger,
  type RetryPolicy,
} from './upstream-server.js';
import type { Principal, ServerConfig } from './types.js';

const PER_USER_IDLE_MS = Number(process.env['MCPROUTER_PER_USER_IDLE_MS'] ?? 600_000);
const TICK_MS = 30_000;

export type ServerRegistryOpts = {
  bus: Bus<EngineEvents>;
  connect: TransportFactory;
  logger: MiniLogger;
  connectConcurrency?: number;
  retry?: RetryPolicy;
};

type Leased = { srv: UpstreamServer; lastUsed: number };

export class ServerRegistry {
  #generation = 0;
  #catalogVersion = 0;
  readonly #shared = new Map<string, UpstreamServer>();
  readonly #perUser = new Map<string, Leased>();
  readonly #configs = new Map<string, ServerConfig>();
  readonly #sem: Semaphore;
  readonly #o: ServerRegistryOpts;
  readonly #ticker: NodeJS.Timeout;

  constructor(o: ServerRegistryOpts) {
    this.#o = o;
    this.#sem = new Semaphore(
      o.connectConcurrency ?? Number(process.env['MCPROUTER_CONNECT_CONCURRENCY'] ?? 8),
    );
    // Ruling P5: the memo in catalog.ts keys on this counter, so a listChanged
    // refresh that swapped a catalog MUST invalidate it.
    o.bus.on('server:catalog', () => {
      this.#catalogVersion += 1;
    });
    this.#ticker = setInterval(() => this.#evictIdle(), TICK_MS);
    this.#ticker.unref?.();
  }

  get generation(): number {
    return this.#generation;
  }
  get catalogVersion(): number {
    return this.#catalogVersion;
  }

  shared(name: string): UpstreamServer | undefined {
    return this.#shared.get(name);
  }

  list(): UpstreamServer[] {
    return [...this.#shared.values()];
  }

  /** Idempotent full-state diff, keyed by name + configHash. The only mutator. */
  async applyConfig(configs: ServerConfig[]): Promise<void> {
    const wanted = new Map(configs.map((c) => [c.name, c]));
    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];

    for (const [name, srv] of [...this.#shared]) {
      const want = wanted.get(name);
      if (want === undefined) {
        removed.push(name);
        this.#shared.delete(name);
        this.#configs.delete(name);
        await this.#stopChildrenOf(name);
        await srv.stop('closed');
        continue;
      }
      const before = this.#configs.get(name);
      // An enabled-only flip is a toggle, never a restart.
      if (before !== undefined && sameExceptEnabled(before, want)) {
        if (before.enabled !== want.enabled) {
          this.#configs.set(name, want);
          if (want.enabled) srv.start();
          else await srv.stop('disabled');
        }
        continue;
      }
      if (configHashOf(want) !== srv.configHash) {
        changed.push(name);
        this.#shared.delete(name);
        await this.#stopChildrenOf(name);
        await srv.stop('closed');
      }
    }

    for (const [name, want] of wanted) {
      this.#configs.set(name, want);
      if (this.#shared.has(name)) continue;
      if (!changed.includes(name)) added.push(name);
      const srv = this.#spawn(want, name);
      this.#shared.set(name, srv);
      if (want.enabled) srv.start();
    }

    this.#generation += 1;
    this.#catalogVersion += 1;
    this.#o.bus.emit('config:applied', {
      generation: this.#generation,
      added,
      changed,
      removed,
    });
  }

  #spawn(cfg: ServerConfig, key: string, headers?: Record<string, string>): UpstreamServer {
    return new UpstreamServer({
      config: cfg,
      key,
      bus: this.#o.bus,
      connect: this.#o.connect,
      connectSem: this.#sem,
      logger: this.#o.logger,
      ...(headers === undefined ? {} : { headers }),
      ...(this.#o.retry === undefined ? {} : { retry: this.#o.retry }),
    });
  }

  /**
   * Per-user instances exist for REMOTE servers only and affect execution, not
   * discovery — the catalog is always the admin-configured one. A per-user server
   * with no resolver FAILS the call; it never falls back to shared credentials,
   * because the fallback direction is the whole vulnerability (D9).
   */
  async lease(name: string, principal: Principal): Promise<UpstreamServer> {
    const cfg = this.#configs.get(name);
    const sharedSrv = this.#shared.get(name);
    if (cfg === undefined || sharedSrv === undefined) {
      throw new CredentialsRequiredError(name);
    }
    if (cfg.credentialMode !== 'per-user') return sharedSrv;
    if (principal.credentials === undefined) throw new CredentialsRequiredError(name);

    const revision = principal.credentials.revision(name);
    const key = `${name}#${principal.id}:${revision}`;
    const hit = this.#perUser.get(key);
    if (hit !== undefined) {
      hit.lastUsed = Date.now();
      return hit.srv;
    }
    const headers = await principal.credentials.resolveHeaders(name);
    const srv = this.#spawn(cfg, key, headers);
    this.#perUser.set(key, { srv, lastUsed: Date.now() });
    srv.start();
    return srv;
  }

  async #stopChildrenOf(name: string): Promise<void> {
    for (const [key, leased] of [...this.#perUser]) {
      if (key === name || key.startsWith(`${name}#`)) {
        this.#perUser.delete(key);
        await leased.srv.stop('closed');
      }
    }
  }

  #evictIdle(): void {
    const cutoff = Date.now() - PER_USER_IDLE_MS;
    for (const [key, leased] of [...this.#perUser]) {
      if (leased.lastUsed < cutoff) {
        this.#perUser.delete(key);
        void leased.srv.stop('closed');
      }
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.#ticker);
    const all = [...this.#shared.values(), ...[...this.#perUser.values()].map((l) => l.srv)];
    this.#perUser.clear();
    await Promise.all(all.map((s) => s.stop('closed')));
  }
}

function sameExceptEnabled(a: ServerConfig, b: ServerConfig): boolean {
  return configHashOf({ ...a, enabled: true }) === configHashOf({ ...b, enabled: true });
}
