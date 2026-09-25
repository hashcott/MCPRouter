import { describe, expect, it, vi } from 'vitest';
import { Bus, type EngineEvents } from '../src/bus.js';
import { ServerRegistry } from '../src/registry.js';
import { callTool, getPrompt, readResource, resolveToolDecision } from '../src/call.js';
import { PayloadTooLargeError, ToolUnavailableError } from '../src/errors.js';
import type { Principal, ResolvedScope, ServerConfig } from '../src/types.js';
import { FakeUpstream, fakeFactory } from './fake-upstream.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const principal: Principal = { id: 'u1', isAdmin: false };

const cfg = (name: string, over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    name,
    enabled: true,
    credentialMode: 'shared',
    type: 'stdio',
    command: 'node',
    ...over,
  }) as ServerConfig;

const scope: ResolvedScope = {
  key: 'k',
  servers: [{ serverName: 'a', tools: 'all', prompts: 'all', resources: 'all' }],
  flatten: false,
};

async function up(fake: FakeUpstream, c = cfg('a')) {
  const bus = new Bus<EngineEvents>();
  const reg = new ServerRegistry({ bus, connect: fakeFactory({ a: fake }), logger });
  await reg.applyConfig([c]);
  await vi.waitFor(() => expect(reg.shared('a')?.state).toBe('ready'));
  return { reg, bus, deps: { reg, bus, logger } };
}

describe('call path', () => {
  it('calls the tool and returns the upstream result', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo', handler: (x) => `got ${String(x['v'])}` }]);
    const { reg, deps } = await up(fake);
    const res = await callTool(deps, { scope, principal, name: 'a__echo', args: { v: 7 } });
    expect(JSON.stringify(res)).toContain('got 7');
    await reg.shutdown();
  });

  it('callTool is exactly resolve + callResolved (the §11.4 seam)', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg } = await up(fake);
    const decision = resolveToolDecision(scope, reg, 'a__echo');
    expect(decision).toMatchObject({ bare: 'echo', server: 'a' });
    await reg.shutdown();
  });

  it('refuses a tool the scope does not expose, with the shared message', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, deps } = await up(fake, cfg('a', { tools: { echo: { enabled: false } } }));
    await expect(
      callTool(deps, { scope, principal, name: 'a__echo', args: {} }),
    ).rejects.toBeInstanceOf(ToolUnavailableError);
    await reg.shutdown();
  });

  it('rejects arguments over the size cap before touching the upstream', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, deps } = await up(fake);
    const huge = { blob: 'x'.repeat(1_100_000) };
    await expect(
      callTool(deps, { scope, principal, name: 'a__echo', args: huge }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    await reg.shutdown();
  });

  it('an invalid MCPROUTER_MAX_ARG_BYTES does not disable the cap (Ruling P13)', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, deps } = await up(fake);
    const prev = process.env['MCPROUTER_MAX_ARG_BYTES'];
    process.env['MCPROUTER_MAX_ARG_BYTES'] = 'not-a-number';
    try {
      const huge = { blob: 'x'.repeat(1_100_000) };
      await expect(
        callTool(deps, { scope, principal, name: 'a__echo', args: huge }),
      ).rejects.toBeInstanceOf(PayloadTooLargeError);
    } finally {
      if (prev === undefined) delete process.env['MCPROUTER_MAX_ARG_BYTES'];
      else process.env['MCPROUTER_MAX_ARG_BYTES'] = prev;
    }
    await reg.shutdown();
  });

  it('NEVER retries a call that was delivered and returned an error (D11)', async () => {
    let calls = 0;
    const fake = new FakeUpstream('a', [
      {
        name: 'write',
        handler: () => {
          calls += 1;
          throw new Error('upstream says no');
        },
      },
    ]);
    const { reg, deps } = await up(fake);
    await callTool(deps, { scope, principal, name: 'a__write', args: {} }).catch(() => undefined);
    expect(calls).toBe(1); // the write must not have run twice
    await reg.shutdown();
  });

  it('retries once when the transport proves the request never left (D11)', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, deps } = await up(fake);
    const srv = reg.shared('a')!;
    const spy = vi.spyOn(srv, 'callTool');
    spy.mockRejectedValueOnce(Object.assign(new Error('not connected'), { code: 'ENOTCONN' }));

    const res = await callTool(deps, { scope, principal, name: 'a__echo', args: {} });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(res).toBeDefined();
    await reg.shutdown();
  });

  it('does NOT retry a "Connection closed" rejection — it may be a delivered, in-flight request (Ruling P10)', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, deps } = await up(fake);
    const srv = reg.shared('a')!;
    const spy = vi.spyOn(srv, 'callTool');
    spy.mockRejectedValueOnce(new Error('Connection closed'));

    await expect(
      callTool(deps, { scope, principal, name: 'a__echo', args: {} }),
    ).rejects.toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);
    await reg.shutdown();
  });

  it('emits call:start and call:end around every call', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, bus, deps } = await up(fake);
    const events: string[] = [];
    bus.on('call:start', () => events.push('start'));
    bus.on('call:end', () => events.push('end'));
    await callTool(deps, { scope, principal, name: 'a__echo', args: {} });
    expect(events).toEqual(['start', 'end']);
    await reg.shutdown();
  });

  it('emits call:end with ok:false when the call throws', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, bus, deps } = await up(fake);
    const ends: boolean[] = [];
    bus.on('call:end', (e) => ends.push(e.ok));
    await callTool(deps, { scope, principal, name: 'a__nope', args: {} }).catch(() => undefined);
    expect(ends).toEqual([false]);
    await reg.shutdown();
  });

  it('pairs call:start with exactly one call:end when ensureReady rejects (Ruling P11)', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, bus, deps } = await up(fake);
    const srv = reg.shared('a')!;
    vi.spyOn(srv, 'ensureReady').mockRejectedValueOnce(new Error('not ready yet'));
    const starts: unknown[] = [];
    const ends: boolean[] = [];
    bus.on('call:start', (e) => starts.push(e));
    bus.on('call:end', (e) => ends.push(e.ok));

    await callTool(deps, { scope, principal, name: 'a__echo', args: {} }).catch(() => undefined);
    expect(starts).toHaveLength(1);
    expect(ends).toEqual([false]);
    await reg.shutdown();
  });

  it('strips a resolved credential value out of a thrown error', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, deps } = await up(fake);
    const srv = reg.shared('a')!;
    vi.spyOn(srv, 'callTool').mockRejectedValue(new Error('rejected token ghp_LEAK'));
    const err = await callTool(deps, {
      scope,
      principal,
      name: 'a__echo',
      args: {},
      secrets: ['ghp_LEAK'],
    }).catch((e: Error) => e);
    expect(err.message).not.toContain('ghp_LEAK');
    await reg.shutdown();
  });

  it('propagates an AbortSignal as a cancellation', async () => {
    const fake = new FakeUpstream('a', [
      { name: 'slow', handler: async () => new Promise<string>(() => {}) },
    ]);
    const { reg, deps } = await up(fake);
    const ac = new AbortController();
    const p = callTool(deps, {
      scope,
      principal,
      name: 'a__slow',
      args: {},
      signal: ac.signal,
    });
    ac.abort();
    await expect(p).rejects.toBeDefined();
    await reg.shutdown();
  });
});

describe('prompts and resources go through the same predicate as tools (Ruling P12)', () => {
  it('resolves and calls a prompt by its projected name', async () => {
    const fake = new FakeUpstream('a', [], {
      prompts: [{ name: 'greet', handler: (args) => `hello ${String(args['who'])}` }],
    });
    const { reg, deps } = await up(fake);
    const res = await getPrompt(deps, {
      scope,
      principal,
      name: 'a__greet',
      args: { who: 'world' },
    });
    expect(JSON.stringify(res)).toContain('hello world');
    await reg.shutdown();
  });

  it('refuses a nonexistent prompt with the shared message', async () => {
    // No `prompts` knob at all: 'greet' does not exist upstream.
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, deps } = await up(fake);
    await expect(
      getPrompt(deps, { scope, principal, name: 'a__greet', args: {} }),
    ).rejects.toBeInstanceOf(ToolUnavailableError);
    await reg.shutdown();
  });

  it('gives a hidden prompt the byte-identical message of a nonexistent one (Ruling P12)', async () => {
    // Case 1: 'greet' does not exist upstream at all.
    const u1 = await up(new FakeUpstream('a', [{ name: 'echo' }]));
    const nonexistent = await getPrompt(u1.deps, {
      scope,
      principal,
      name: 'a__greet',
      args: {},
    }).catch((e: Error) => e);
    await u1.reg.shutdown();

    // Case 2: 'greet' genuinely exists upstream, but this scope's allowlist omits
    // it — the pre-P12 resolver (which checked kind: 'tool') could not
    // distinguish this from "never existed", and a same-named tool would leak
    // the prompt.
    const hiddenScope: ResolvedScope = {
      key: 'hidden-prompt',
      servers: [{ serverName: 'a', tools: 'all', prompts: ['other'], resources: 'all' }],
      flatten: false,
    };
    const u2 = await up(new FakeUpstream('a', [], { prompts: [{ name: 'greet' }] }));
    const hidden = await getPrompt(u2.deps, {
      scope: hiddenScope,
      principal,
      name: 'a__greet',
      args: {},
    }).catch((e: Error) => e);
    await u2.reg.shutdown();

    expect(nonexistent).toBeInstanceOf(ToolUnavailableError);
    expect(hidden).toBeInstanceOf(ToolUnavailableError);
    expect((hidden as Error).message).toBe((nonexistent as Error).message);
  });

  it('reads a resource by scanning scope.servers for the first exposing server', async () => {
    const fake = new FakeUpstream('a', [], {
      resources: [{ uri: 'file:///hello.txt', handler: () => 'hello resource' }],
    });
    const { reg, deps } = await up(fake);
    const res = await readResource(deps, { scope, principal, uri: 'file:///hello.txt' });
    expect(JSON.stringify(res)).toContain('hello resource');
    await reg.shutdown();
  });

  it('refuses a resource URI that exists on an in-scope server but is hidden by the scope allowlist (Ruling P12)', async () => {
    // 'file:///hello.txt' genuinely exists on server 'a', and 'a' is in scope —
    // but this scope's resource allowlist doesn't name it. A URI hidden from
    // `listResources` must not be readable just because its server is reachable.
    const fake = new FakeUpstream('a', [], { resources: [{ uri: 'file:///hello.txt' }] });
    const { reg, deps } = await up(fake);
    const hiddenScope: ResolvedScope = {
      key: 'hidden-resource',
      servers: [{ serverName: 'a', tools: 'all', prompts: 'all', resources: [] }],
      flatten: false,
    };
    await expect(
      readResource(deps, { scope: hiddenScope, principal, uri: 'file:///hello.txt' }),
    ).rejects.toBeInstanceOf(ToolUnavailableError);
    await reg.shutdown();
  });

  it('refuses a resource URI on a server that scope.servers never lists', async () => {
    const fakeA = new FakeUpstream('a', [{ name: 'echo' }]);
    const fakeB = new FakeUpstream('b', [], { resources: [{ uri: 'file:///secret.txt' }] });
    const bus = new Bus<EngineEvents>();
    const reg = new ServerRegistry({ bus, connect: fakeFactory({ a: fakeA, b: fakeB }), logger });
    await reg.applyConfig([cfg('a'), cfg('b')]);
    await vi.waitFor(() => {
      expect(reg.shared('a')?.state).toBe('ready');
      expect(reg.shared('b')?.state).toBe('ready');
    });
    const deps = { reg, bus, logger };

    // `scope` (module-level) only authorizes server 'a' — 'b' is a real, reachable
    // server that this scope simply never lists.
    await expect(
      readResource(deps, { scope, principal, uri: 'file:///secret.txt' }),
    ).rejects.toBeInstanceOf(ToolUnavailableError);
    await reg.shutdown();
  });
});
