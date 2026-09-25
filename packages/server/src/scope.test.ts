import { describe, expect, it } from 'vitest';
import { EMPTY_SNAPSHOT, reusedSlugs, resolveTarget, type Snapshot } from './scope.js';

const snap: Snapshot = {
  servers: [
    { id: 'id-fs', slug: 'fs', enabled: true },
    { id: 'id-gh', slug: 'gh', enabled: true },
    { id: 'id-off', slug: 'off', enabled: false },
  ],
  groups: new Map([
    [
      'eng',
      {
        id: 'id-eng',
        members: [
          { serverId: 'id-fs', serverSlug: 'fs', tools: 'all', prompts: 'all', resources: 'all' },
          { serverId: 'id-off', serverSlug: 'off', tools: 'all', prompts: 'all', resources: 'all' },
          {
            serverId: 'id-gh',
            serverSlug: 'gh',
            alias: 'git',
            tools: ['create_issue'],
            prompts: [],
            resources: [],
          },
        ],
      },
    ],
    ['empty', { id: 'id-empty', members: [] }],
  ]),
};

describe('resolveTarget', () => {
  it('all: enabled servers in the scope, EVERY server in serverIds (R4)', () => {
    const r = resolveTarget(snap, { kind: 'all' });
    expect(r?.scope.servers.map((s) => s.serverName)).toEqual(['fs', 'gh']);
    expect(r?.serverIds).toEqual(['id-fs', 'id-gh', 'id-off']);
    expect(r?.scope.flatten).toBe(false);
    expect(r?.label).toBe('all');
    expect(r?.groupId).toBeUndefined();
  });

  it('group: members with their selection and alias; complete serverIds', () => {
    const r = resolveTarget(snap, { kind: 'group', slug: 'eng' });
    expect(r?.groupId).toBe('id-eng');
    expect(r?.label).toBe('g/eng');
    expect(r?.serverIds).toEqual(['id-fs', 'id-off', 'id-gh']);
    expect(r?.scope.flatten).toBe(false);
    expect(r?.scope.servers).toEqual([
      { serverName: 'fs', tools: 'all', prompts: 'all', resources: 'all' },
      { serverName: 'off', tools: 'all', prompts: 'all', resources: 'all' },
      { serverName: 'gh', alias: 'git', tools: ['create_issue'], prompts: [], resources: [] },
    ]);
  });

  it('an empty group resolves to an empty scope, not to null and never to "all"', () => {
    const r = resolveTarget(snap, { kind: 'group', slug: 'empty' });
    expect(r?.scope.servers).toEqual([]);
    expect(r?.serverIds).toEqual([]);
  });

  it('server: one server, flattened', () => {
    const r = resolveTarget(snap, { kind: 'server', slug: 'gh' });
    expect(r?.scope.flatten).toBe(true);
    expect(r?.scope.servers.map((s) => s.serverName)).toEqual(['gh']);
    expect(r?.serverIds).toEqual(['id-gh']);
    expect(r?.label).toBe('s/gh');
  });

  it.each([[{ kind: 'group', slug: 'nope' }], [{ kind: 'server', slug: 'nope' }]] as const)(
    'unknown %j → null',
    (t) => expect(resolveTarget(snap, t)).toBeNull(),
  );

  it('scope keys differ between routes and are stable for one route', () => {
    const a = resolveTarget(snap, { kind: 'group', slug: 'eng' })?.scope.key;
    expect(a).toBe(resolveTarget(snap, { kind: 'group', slug: 'eng' })?.scope.key);
    expect(a).not.toBe(resolveTarget(snap, { kind: 'all' })?.scope.key);
    expect(resolveTarget(snap, { kind: 'server', slug: 'fs' })?.scope.key).not.toBe(
      resolveTarget(snap, { kind: 'group', slug: 'eng' })?.scope.key,
    );
  });

  it('the empty snapshot serves an empty "all"', () => {
    expect(resolveTarget(EMPTY_SNAPSHOT, { kind: 'all' })?.scope.servers).toEqual([]);
  });
});

// While the Engine swaps configs, a slug whose server was deleted and re-created must not
// route through the OLD snapshot's memberships to the NEW upstream.
describe('slug reuse during applyConfig', () => {
  const next: Snapshot = {
    servers: [
      { id: 'id-fs-NEW', slug: 'fs', enabled: true },
      { id: 'id-gh', slug: 'gh', enabled: true },
    ],
    groups: new Map(),
  };

  it('reusedSlugs finds slugs whose server id changed, and only those', () => {
    expect([...reusedSlugs(snap, next)]).toEqual(['fs']);
    expect([...reusedSlugs(snap, snap)]).toEqual([]);
  });
});
