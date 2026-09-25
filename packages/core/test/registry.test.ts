import { describe, expect, it, vi } from 'vitest';
import { Bus, type EngineEvents } from '../src/bus.js';
import { ServerRegistry } from '../src/registry.js';
import { CredentialsRequiredError, ToolUnavailableError } from '../src/errors.js';
import { projectTools, resolveTool } from '../src/catalog.js';
import type { Principal, ResolvedScope, ServerConfig } from '../src/types.js';
import { FakeUpstream, fakeFactory } from './fake-upstream.js';

const cfg = (name: string, over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    name,
    enabled: true,
    credentialMode: 'shared',
    type: 'stdio',
    command: 'node',
    ...over,
  }) as ServerConfig;

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function make(fakes: Record<string, FakeUpstream>, connectConcurrency = 8) {
  const bus = new Bus<EngineEvents>();
  const reg = new ServerRegistry({
    bus,
    connect: fakeFactory(fakes),
    logger,
    connectConcurrency,
    retry: { baseMs: 5, maxMs: 20 },
  });
  return { reg, bus };
}

const admin: Principal = { id: 'u1', isAdmin: true };

describe('ServerRegistry', () => {
  it('adds servers and bumps the generation once per applyConfig', async () => {
    const { reg } = make({ a: new FakeUpstream('a', [{ name: 't' }]) });
    await reg.applyConfig([cfg('a')]);
    expect(reg.generation).toBe(1);
    expect(reg.shared('a')).toBeDefined();
    await reg.shutdown();
  });

  it('leaves an unchanged server completely untouched across applyConfig', async () => {
    const fa = new FakeUpstream('a', [{ name: 't' }]);
    const { reg } = make({ a: fa, b: new FakeUpstream('b', []) });
    await reg.applyConfig([cfg('a')]);
    await vi.waitFor(() => expect(reg.shared('a')?.state).toBe('ready'));
    const first = reg.shared('a');
    const connects = fa.connects;

    await reg.applyConfig([cfg('a'), cfg('b')]);
    expect(reg.shared('a')).toBe(first);
    expect(fa.connects).toBe(connects);
    await reg.shutdown();
  });

  it('replaces a server whose config actually changed', async () => {
    const fa = new FakeUpstream('a', [{ name: 't' }]);
    const { reg } = make({ a: fa });
    await reg.applyConfig([cfg('a')]);
    const first = reg.shared('a');
    await reg.applyConfig([cfg('a', { command: 'other' })]);
    expect(reg.shared('a')).not.toBe(first);
    await reg.shutdown();
  });

  it('removes a server that disappeared from the config', async () => {
    const { reg } = make({ a: new FakeUpstream('a', []), b: new FakeUpstream('b', []) });
    await reg.applyConfig([cfg('a'), cfg('b')]);
    await reg.applyConfig([cfg('a')]);
    expect(reg.shared('b')).toBeUndefined();
    await reg.shutdown();
  });

  it('toggles enabled without tearing the instance down', async () => {
    const fa = new FakeUpstream('a', [{ name: 't' }]);
    const { reg } = make({ a: fa });
    await reg.applyConfig([cfg('a')]);
    await vi.waitFor(() => expect(reg.shared('a')?.state).toBe('ready'));
    const first = reg.shared('a');

    await reg.applyConfig([cfg('a', { enabled: false })]);
    expect(reg.shared('a')).toBe(first);
    await vi.waitFor(() => expect(reg.shared('a')?.state).toBe('disabled'));
    await reg.shutdown();
  });

  it('bounds startup connect concurrency', async () => {
    const fakes: Record<string, FakeUpstream> = {};
    for (const n of ['a', 'b', 'c', 'd']) {
      fakes[n] = new FakeUpstream(n, [{ name: 't' }], { connectDelayMs: 25 });
    }
    const { reg } = make(fakes, 2);
    const started = Date.now();
    await reg.applyConfig([cfg('a'), cfg('b'), cfg('c'), cfg('d')]);
    await vi.waitFor(() => expect(reg.list().every((s) => s.state === 'ready')).toBe(true), {
      timeout: 3000,
    });
    // 4 servers, concurrency 2, 25ms each => at least two waves.
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    await reg.shutdown();
  });

  it('bumps catalogVersion when a catalog is emitted, not only on applyConfig (Ruling P5)', async () => {
    const fa = new FakeUpstream('a', [{ name: 't' }]);
    const { reg } = make({ a: fa });
    await reg.applyConfig([cfg('a')]);
    await vi.waitFor(() => expect(reg.shared('a')?.state).toBe('ready'));
    const before = reg.catalogVersion;

    fa.setTools([{ name: 't' }, { name: 'u' }]);
    reg.shared('a')?.refresh();
    await vi.waitFor(() => expect(reg.catalogVersion).toBeGreaterThan(before));
    await reg.shutdown();
  });

  it('lease() fails closed when a per-user server has no credential resolver', async () => {
    const { reg } = make({ a: new FakeUpstream('a', []) });
    await reg.applyConfig([cfg('a', { credentialMode: 'per-user' })]);
    await expect(reg.lease('a', admin)).rejects.toBeInstanceOf(CredentialsRequiredError);
    await reg.shutdown();
  });

  it('lease() returns the shared instance for a shared-credential server', async () => {
    const { reg } = make({ a: new FakeUpstream('a', [{ name: 't' }]) });
    await reg.applyConfig([cfg('a')]);
    await expect(reg.lease('a', admin)).resolves.toBe(reg.shared('a'));
    await reg.shutdown();
  });

  it('shutdown stops every server and leaves nothing running', async () => {
    const { reg } = make({ a: new FakeUpstream('a', [{ name: 't' }]) });
    await reg.applyConfig([cfg('a')]);
    await reg.shutdown();
    expect(reg.list().every((s) => s.state === 'closed')).toBe(true);
  });

  it('a disabled server is neither listed nor callable, and re-enabling brings it back', async () => {
    const fa = new FakeUpstream('a', [{ name: 't' }]);
    const { reg } = make({ a: fa });
    const scope: ResolvedScope = {
      key: 's',
      servers: [{ serverName: 'a', tools: 'all', prompts: 'all', resources: 'all' }],
      flatten: false,
    };
    await reg.applyConfig([cfg('a')]);
    await vi.waitFor(() => expect(reg.shared('a')?.state).toBe('ready'));

    await reg.applyConfig([cfg('a', { enabled: false })]);
    expect(projectTools(scope, reg)).toEqual([]);
    const hidden = (() => {
      try {
        return resolveTool(scope, reg, 'a__t');
      } catch (e) {
        return e as Error;
      }
    })();
    expect(hidden).toBeInstanceOf(ToolUnavailableError);
    expect((hidden as Error).message).toBe(new ToolUnavailableError('a__t').message);

    await reg.applyConfig([cfg('a')]);
    await vi.waitFor(() => expect(reg.shared('a')?.state).toBe('ready'));
    expect(projectTools(scope, reg).map((t) => t.name)).toEqual(['a__t']);
    await reg.shutdown();
  });

  it('concurrent first leases for one user share a single per-user instance', async () => {
    const fa = new FakeUpstream('a', [{ name: 't' }]);
    const { reg } = make({ a: fa });
    await reg.applyConfig([cfg('a', { credentialMode: 'per-user' })]);
    const user: Principal = {
      id: 'u2',
      isAdmin: false,
      credentials: {
        revision: () => 1,
        resolveHeaders: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { authorization: 'Bearer x' };
        },
      },
    } as Principal;
    const [x, y] = await Promise.all([reg.lease('a', user), reg.lease('a', user)]);
    expect(x).toBe(y);
    await reg.shutdown();
    expect(fa.open).toBe(0);
  });

  it('overlapping applyConfig calls apply in order and the last one wins', async () => {
    const fa = new FakeUpstream('a', [{ name: 't' }]);
    const { reg } = make({ a: fa });
    await reg.applyConfig([cfg('a', { args: ['1'] })]);
    await vi.waitFor(() => expect(reg.shared('a')?.state).toBe('ready'));
    await Promise.all([
      reg.applyConfig([cfg('a', { args: ['2'] })]),
      reg.applyConfig([cfg('a', { args: ['3'] })]),
    ]);
    expect(reg.shared('a')?.config).toMatchObject({ args: ['3'] });
    // #configs must agree with what runs: re-applying v2 is a real change.
    await reg.applyConfig([cfg('a', { args: ['2'] })]);
    expect(reg.shared('a')?.config).toMatchObject({ args: ['2'] });
    await reg.shutdown();
    expect(fa.open).toBe(0);
  });
});
