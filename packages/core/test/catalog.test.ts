import { describe, expect, it, vi } from 'vitest';
import { Bus, type EngineEvents } from '../src/bus.js';
import { ServerRegistry } from '../src/registry.js';
import { isExposed, label, project, projectTools, resolveTool } from '../src/catalog.js';
import { ToolUnavailableError } from '../src/errors.js';
import type { ResolvedScope, ServerConfig, ServerSelection } from '../src/types.js';
import { FakeUpstream, fakeFactory } from './fake-upstream.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const cfg = (name: string, over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    name,
    enabled: true,
    credentialMode: 'shared',
    type: 'stdio',
    command: 'node',
    ...over,
  }) as ServerConfig;

const sel = (serverName: string, over: Partial<ServerSelection> = {}): ServerSelection => ({
  serverName,
  tools: 'all',
  prompts: 'all',
  resources: 'all',
  ...over,
});

const scopeOf = (servers: ServerSelection[], flatten = false): ResolvedScope => ({
  key: `${servers.map((s) => `${s.serverName}/${s.alias ?? ''}/${String(s.tools)}`).join('|')}:${String(flatten)}`,
  servers,
  flatten,
});

async function ready(configs: ServerConfig[], fakes: Record<string, FakeUpstream>) {
  const bus = new Bus<EngineEvents>();
  const reg = new ServerRegistry({
    bus,
    connect: fakeFactory(fakes),
    logger,
    retry: { baseMs: 5, maxMs: 20 },
  });
  await reg.applyConfig(configs);
  await vi.waitFor(() =>
    expect(
      reg
        .list()
        .filter((s) => s.config.enabled)
        .every((s) => s.state === 'ready'),
    ).toBe(true),
  );
  return reg;
}

describe('naming', () => {
  it('prefixes with the server name, or the alias when set', () => {
    expect(project(sel('github'), 'create_issue', false)).toBe('github__create_issue');
    expect(project(sel('github', { alias: 'gh' }), 'create_issue', false)).toBe('gh__create_issue');
    expect(label(sel('github', { alias: 'gh' }))).toBe('gh');
  });

  it('strips the prefix entirely on a flattened single-server route', () => {
    expect(project(sel('github'), 'create_issue', true)).toBe('create_issue');
  });
});

describe('the one predicate', () => {
  it('lists tools from every selected server, namespaced', async () => {
    const reg = await ready([cfg('a'), cfg('b')], {
      a: new FakeUpstream('a', [{ name: 'one' }]),
      b: new FakeUpstream('b', [{ name: 'two' }]),
    });
    const names = projectTools(scopeOf([sel('a'), sel('b')]), reg).map((t) => t.name);
    expect(names.sort()).toEqual(['a__one', 'b__two']);
    await reg.shutdown();
  });

  it('an empty scope means an empty catalog, never everything', async () => {
    const reg = await ready([cfg('a')], { a: new FakeUpstream('a', [{ name: 'one' }]) });
    expect(projectTools(scopeOf([]), reg)).toEqual([]);
    await reg.shutdown();
  });

  it('a disabled server hides its tools from list AND call (layer 1)', async () => {
    const reg = await ready([cfg('a', { enabled: false })], {
      a: new FakeUpstream('a', [{ name: 'one' }]),
    });
    const scope = scopeOf([sel('a')]);
    expect(projectTools(scope, reg)).toEqual([]);
    expect(() => resolveTool(scope, reg, 'a__one')).toThrow(ToolUnavailableError);
    await reg.shutdown();
  });

  it('a per-tool disable hides it from list AND call (layer 2)', async () => {
    const reg = await ready([cfg('a', { tools: { one: { enabled: false } } })], {
      a: new FakeUpstream('a', [{ name: 'one' }, { name: 'two' }]),
    });
    const scope = scopeOf([sel('a')]);
    expect(projectTools(scope, reg).map((t) => t.name)).toEqual(['a__two']);
    expect(() => resolveTool(scope, reg, 'a__one')).toThrow(ToolUnavailableError);
    await reg.shutdown();
  });

  it('a scope allowlist hides the rest from list AND call (layer 3)', async () => {
    const reg = await ready([cfg('a')], {
      a: new FakeUpstream('a', [{ name: 'one' }, { name: 'two' }]),
    });
    const scope = scopeOf([sel('a', { tools: ['one'] })]);
    expect(projectTools(scope, reg).map((t) => t.name)).toEqual(['a__one']);
    expect(() => resolveTool(scope, reg, 'a__two')).toThrow(ToolUnavailableError);
    await reg.shutdown();
  });

  it('hidden, disabled and never-existed are byte-identical to the caller', async () => {
    const reg = await ready([cfg('a', { tools: { two: { enabled: false } } })], {
      a: new FakeUpstream('a', [{ name: 'one' }, { name: 'two' }]),
    });
    const scope = scopeOf([sel('a', { tools: ['one'] })]);
    const messages = ['a__two', 'a__three', 'b__one'].map((n) => {
      try {
        resolveTool(scope, reg, n);
        return 'RESOLVED';
      } catch (e) {
        return (e as Error).message.replace(n, '<name>');
      }
    });
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe('Tool not found: <name>');
    await reg.shutdown();
  });

  it('resolves through an alias and back to the bare upstream name', async () => {
    const reg = await ready([cfg('a')], { a: new FakeUpstream('a', [{ name: 'one' }]) });
    const scope = scopeOf([sel('a', { alias: 'zz' })]);
    expect(projectTools(scope, reg).map((t) => t.name)).toEqual(['zz__one']);
    expect(resolveTool(scope, reg, 'zz__one')).toMatchObject({ bare: 'one' });
    await reg.shutdown();
  });

  it('resolves a flattened name on a single-server scope', async () => {
    const reg = await ready([cfg('a')], { a: new FakeUpstream('a', [{ name: 'one' }]) });
    const scope = scopeOf([sel('a')], true);
    expect(projectTools(scope, reg).map((t) => t.name)).toEqual(['one']);
    expect(resolveTool(scope, reg, 'one').bare).toBe('one');
    await reg.shutdown();
  });

  it('isExposed is the SAME function the list path uses', async () => {
    const reg = await ready([cfg('a')], { a: new FakeUpstream('a', [{ name: 'one' }]) });
    const srv = reg.shared('a');
    expect(srv).toBeDefined();
    expect(isExposed(srv!, srv!.config, sel('a'), 'tool', 'one')).toBe(true);
    expect(isExposed(srv!, srv!.config, sel('a', { tools: [] }), 'tool', 'one')).toBe(false);
    await reg.shutdown();
  });

  it('invalidates the memo when a refresh changes the catalog (Ruling P5)', async () => {
    const fa = new FakeUpstream('a', [{ name: 'one' }]);
    const reg = await ready([cfg('a')], { a: fa });
    const scope = scopeOf([sel('a')]);
    expect(projectTools(scope, reg).map((t) => t.name)).toEqual(['a__one']);

    fa.setTools([{ name: 'one' }, { name: 'two' }]);
    reg.shared('a')?.refresh();
    await vi.waitFor(() =>
      expect(
        projectTools(scope, reg)
          .map((t) => t.name)
          .sort(),
      ).toEqual(['a__one', 'a__two']),
    );
    await reg.shutdown();
  });
});
