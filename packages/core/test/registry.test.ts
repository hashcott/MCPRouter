import { describe, expect, it, vi } from 'vitest';
import { Bus, type EngineEvents } from '../src/bus.js';
import { ServerRegistry } from '../src/registry.js';
import { CredentialsRequiredError } from '../src/errors.js';
import type { Principal, ServerConfig } from '../src/types.js';
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
});
