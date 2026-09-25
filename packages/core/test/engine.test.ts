import { describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/engine.js';
import type { Principal, ResolvedScope, ServerConfig } from '../src/types.js';
import { FakeUpstream, fakeFactory } from './fake-upstream.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const principal: Principal = { id: 'u1', isAdmin: true };

const cfg = (name: string): ServerConfig => ({
  name,
  enabled: true,
  credentialMode: 'shared',
  type: 'stdio',
  command: 'node',
});

const scopeOf = (names: string[], flatten = false): ResolvedScope => ({
  key: `${names.join(',')}:${String(flatten)}`,
  servers: names.map((serverName) => ({
    serverName,
    tools: 'all' as const,
    prompts: 'all' as const,
    resources: 'all' as const,
  })),
  flatten,
});

describe('Engine', () => {
  it('aggregates two upstreams into one namespaced catalog and calls through it', async () => {
    const fakes = {
      fs: new FakeUpstream('fs', [{ name: 'read_file', handler: () => 'contents' }]),
      gh: new FakeUpstream('gh', [{ name: 'create_issue' }]),
    };
    const engine = new Engine({ logger, connect: fakeFactory(fakes) });
    await engine.applyConfig([cfg('fs'), cfg('gh')]);
    await vi.waitFor(() => expect(engine.status().every((s) => s.state === 'ready')).toBe(true));

    const scope = scopeOf(['fs', 'gh']);
    const tools = await engine.listTools(scope, principal);
    expect(tools.map((t) => t.name).sort()).toEqual(['fs__read_file', 'gh__create_issue']);

    const res = await engine.callTool({
      scope,
      principal,
      name: 'fs__read_file',
      args: {},
    });
    expect(JSON.stringify(res)).toContain('contents');
    await engine.shutdown();
  });

  it('status() is synchronous and needs no upstream I/O', async () => {
    const engine = new Engine({
      logger,
      connect: fakeFactory({ fs: new FakeUpstream('fs', [{ name: 't' }]) }),
    });
    await engine.applyConfig([cfg('fs')]);
    const status = engine.status();
    expect(status).toHaveLength(1);
    expect(status[0]?.name).toBe('fs');
    await engine.shutdown();
  });

  it('exposes the per-server catalog for later context-cost work', async () => {
    const engine = new Engine({
      logger,
      connect: fakeFactory({ fs: new FakeUpstream('fs', [{ name: 't' }]) }),
    });
    await engine.applyConfig([cfg('fs')]);
    await vi.waitFor(() => expect(engine.catalog('fs')?.tools.size).toBe(1));
    expect(engine.catalog('nope')).toBeUndefined();
    await engine.shutdown();
  });

  it('shutdown is idempotent', async () => {
    const engine = new Engine({
      logger,
      connect: fakeFactory({ fs: new FakeUpstream('fs', []) }),
    });
    await engine.applyConfig([cfg('fs')]);
    await engine.shutdown();
    await expect(engine.shutdown()).resolves.toBeUndefined();
  });
});
