import { describe, expect, it } from 'vitest';
import {
  compileRules,
  describeRule,
  evaluate,
  findShadows,
  globMatch,
  pathUnder,
  pointerGet,
  type CompiledRule,
  type PolicyInput,
  type RuleRow,
} from './policy.js';

const FS = '00000000-0000-4000-8000-0000000000f5';
const GH = '00000000-0000-4000-8000-0000000000a1';

let n = 0;
const rule = (over: Partial<CompiledRule> = {}): CompiledRule => {
  n += 1;
  return {
    id: `r${n}`,
    seq: n * 10,
    subjectKind: 'any',
    subjectId: null,
    serverId: FS,
    serverSlug: 'fs',
    itemKind: 'tool',
    namePattern: '*',
    effect: 'deny',
    args: [],
    note: null,
    expiresAt: null,
    ...over,
  };
};
const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  subject: { role: 'operator', keyId: 'k1' },
  serverId: FS,
  kind: 'tool',
  bare: 'write_file',
  args: {},
  now: 1_000,
  ...over,
});

describe('globMatch — `*` is the only metacharacter', () => {
  it.each([
    ['*', 'anything', true],
    ['*', '', true],
    ['write_file', 'write_file', true],
    ['write_file', 'write_files', false],
    ['write_*', 'write_file', true],
    ['write_*', 'read_file', false],
    ['*_file', 'read_file', true],
    ['*_file*', 'read_file_v2', true],
    ['a*b*c', 'axxbyyc', true],
    ['a*b*c', 'axxbyy', false],
    ['.', 'x', false], // not a regex dot
    ['a.b', 'a.b', true],
  ])('%j vs %j → %s', (p, s, want) => expect(globMatch(p, s)).toBe(want));

  it('stays linear on a pathological input (no ReDoS)', () => {
    const started = Date.now();
    expect(globMatch(`${'*a'.repeat(60)}b`, 'a'.repeat(5_000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('pointerGet', () => {
  const doc = { a: { 'b/c': 1, 'd~e': 2, list: ['x', 'y'] }, z: null };
  it.each([
    ['', true, doc],
    ['/a/b~1c', true, 1],
    ['/a/d~0e', true, 2],
    ['/a/list/1', true, 'y'],
    ['/z', true, null],
    ['/nope', false, undefined],
    ['/a/list/9', false, undefined],
    ['/z/deeper', false, undefined],
  ])('%j', (ptr, found, value) => {
    const r = pointerGet(doc, ptr);
    expect(r.found).toBe(found);
    if (found) expect(r.value).toEqual(value);
  });

  it('never walks the prototype chain', () => {
    expect(pointerGet({}, '/__proto__').found).toBe(false);
    expect(pointerGet({}, '/constructor').found).toBe(false);
    expect(pointerGet({ a: {} }, '/a/toString').found).toBe(false);
  });
});

describe('pathUnder — lexical, honestly', () => {
  it.each([
    ['/tmp/a.txt', '/tmp', true],
    ['/tmp', '/tmp', true],
    ['/tmp/sub/./x', '/tmp/', true],
    ['/tmpx/a', '/tmp', false], // a sibling that shares the prefix
    ['/tmp/../etc/passwd', '/tmp', false],
    ['/tmp/a/../../etc', '/tmp', false],
    ['tmp/a', '/tmp', false], // relative: meaning depends on a cwd we cannot see
    ['/tmp/a\0b', '/tmp', false],
    ['/tmp\\..\\etc', '/tmp', false],
    ['/anything', '/', true],
  ])('%j under %j → %s', (v, b, want) => expect(pathUnder(v, b)).toBe(want));
});

describe('evaluate — first match, default allow', () => {
  it('no rule matches → allow with no rule id', () => {
    expect(evaluate([rule({ serverId: GH })], input())).toEqual({ effect: 'allow', ruleId: null });
  });

  it('a matching deny wins, with its note and a selector reason', () => {
    const r = rule({ note: 'writes go through the change queue' });
    expect(evaluate([r], input())).toEqual({
      effect: 'deny',
      ruleId: r.id,
      note: 'writes go through the change queue',
      reason: { k: 'selector' },
    });
  });

  it('first match: an earlier allow stops a later deny, and vice versa', () => {
    const allow = rule({ effect: 'allow' });
    const deny = rule();
    expect(evaluate([allow, deny], input()).effect).toBe('allow');
    expect(evaluate([deny, allow], input()).effect).toBe('deny');
  });

  it.each([
    ['another server', { serverId: GH }],
    ['another kind', { itemKind: 'prompt' as const }],
    ['another name', { namePattern: 'read_*' }],
    ['another role', { subjectKind: 'role' as const, subjectId: 'viewer' }],
    ['another key', { subjectKind: 'api_key' as const, subjectId: 'k2' }],
    ['an expired rule', { expiresAt: 1_000 }],
  ])('skips %s', (_n, over) => {
    expect(evaluate([rule(over)], input()).effect).toBe('allow');
  });

  it('matches by the OWNING user role and by key id', () => {
    expect(evaluate([rule({ subjectKind: 'role', subjectId: 'operator' })], input()).effect).toBe(
      'deny',
    );
    expect(evaluate([rule({ subjectKind: 'api_key', subjectId: 'k1' })], input()).effect).toBe(
      'deny',
    );
  });

  it('a rule that expires later still applies now', () => {
    expect(evaluate([rule({ expiresAt: 2_000 })], input()).effect).toBe('deny');
  });

  describe('an allow with argument constraints', () => {
    const guarded = () =>
      rule({
        effect: 'allow',
        note: 'only under /srv/data',
        args: [
          { op: 'pathUnder', ptr: '/path', value: '/srv/data' },
          { op: 'maxLen', ptr: '/path', n: 64 },
        ],
      });

    it('passes when every constraint holds', () => {
      expect(evaluate([guarded()], input({ args: { path: '/srv/data/x' } })).effect).toBe('allow');
    });

    it('fails CLOSED — a deny naming the pointer and op, never the value — instead of trying the next rule', () => {
      const r = guarded();
      const d = evaluate([r, rule({ effect: 'allow' })], input({ args: { path: '/etc/passwd' } }));
      expect(d).toEqual({
        effect: 'deny',
        ruleId: r.id,
        note: 'only under /srv/data',
        reason: { k: 'args', ptr: '/path', op: 'pathUnder' },
      });
      expect(JSON.stringify(d)).not.toContain('/etc/passwd');
    });

    it.each([
      ['a missing path', {}],
      ['an array where a string belongs', { path: ['/srv/data/x', '/etc'] }],
      ['a number', { path: 7 }],
      ['a string over maxLen', { path: `/srv/data/${'x'.repeat(80)}` }],
    ])('%s fails', (_n, args) => {
      expect(evaluate([guarded()], input({ args })).effect).toBe('deny');
    });
  });

  it.each([
    [{ op: 'present', ptr: '/a' }, { a: null }, true],
    [{ op: 'present', ptr: '/a' }, {}, false],
    [{ op: 'absent', ptr: '/a' }, {}, true],
    [{ op: 'absent', ptr: '/a' }, { a: 1 }, false],
    [{ op: 'equals', ptr: '/m', value: 'ro' }, { m: 'ro' }, true],
    [{ op: 'equals', ptr: '/m', value: 'ro' }, { m: 'rw' }, false],
    [{ op: 'oneOf', ptr: '/m', values: ['a', 'b'] }, { m: 'b' }, true],
    [{ op: 'oneOf', ptr: '/m', values: ['a', 'b'] }, { m: 'c' }, false],
    [{ op: 'prefix', ptr: '/u', value: 'https://' }, { u: 'https://x' }, true],
    [{ op: 'prefix', ptr: '/u', value: 'https://' }, { u: 'http://x' }, false],
    [{ op: 'maxLen', ptr: '/s', n: 3 }, { s: 'abc' }, true],
    [{ op: 'maxLen', ptr: '/s', n: 3 }, { s: 'abcd' }, false],
  ] as const)('op %j on %j → %s', (c, args, allowed) => {
    const r = rule({ effect: 'allow', args: [c as never] });
    expect(evaluate([r], input({ args })).effect).toBe(allowed ? 'allow' : 'deny');
  });
});

describe('compileRules', () => {
  const row = (over: Partial<RuleRow> = {}): RuleRow => ({
    id: 'x',
    seq: 10,
    enabled: true,
    subjectKind: 'any',
    subjectId: null,
    serverId: FS,
    serverSlug: 'fs',
    itemKind: 'tool',
    namePattern: '*',
    effect: 'allow',
    args: [],
    note: null,
    expiresAt: null,
    ...over,
  });

  it('orders by seq, drops disabled rows, converts expiry to ms', () => {
    const { rules, broken } = compileRules([
      row({ id: 'b', seq: 20 }),
      row({ id: 'a', seq: 10, expiresAt: new Date(5_000) }),
      row({ id: 'off', seq: 5, enabled: false }),
    ]);
    expect(rules.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rules[0]?.expiresAt).toBe(5_000);
    expect(broken).toEqual([]);
  });

  it('a row that fails validation is enforced as an unconditional deny — never skipped (skipping would drop constraints)', () => {
    const { rules, broken } = compileRules([
      row({ id: 'bad', args: [{ op: 'regex', ptr: '/p', value: '.*' }] }),
    ]);
    expect(broken).toEqual(['bad']);
    expect(rules[0]).toMatchObject({ effect: 'deny', args: [] });
  });
});

describe('describeRule — every rule is one sentence', () => {
  it.each([
    [
      rule({ note: 'use the queue' }),
      /^Anyone is DENIED every tool items on fs — "use the queue"\.$/,
    ],
    [
      rule({ effect: 'allow', subjectKind: 'role', subjectId: 'viewer', namePattern: 'read_*' }),
      /Anyone with role viewer is ALLOWED every tool "read_\*" on fs\./,
    ],
    [
      rule({ effect: 'allow', args: [{ op: 'pathUnder', ptr: '/path', value: '/srv' }] }),
      /ALLOWED tool items on fs only when \/path is a path under \/srv \(lexical: symlinks are not resolved\); otherwise DENIED\./,
    ],
    [
      rule({ subjectKind: 'api_key', subjectId: 'k9', expiresAt: Date.UTC(2030, 0, 1) }),
      /API key k9 is DENIED .* until 2030-01-01T00:00:00\.000Z\./,
    ],
  ])('%#', (r, re) => expect(describeRule(r)).toMatch(re));

  it('a prefix op says it is NOT a path check', () => {
    expect(
      describeRule(rule({ effect: 'allow', args: [{ op: 'prefix', ptr: '/p', value: '/tmp' }] })),
    ).toContain('a string prefix, not a path check');
  });
});

describe('findShadows', () => {
  it('a broad unconditional rule above a narrower one shadows it', () => {
    const broad = rule({ effect: 'allow' });
    const narrow = rule({ namePattern: 'write_*' });
    expect(findShadows([broad, narrow])).toEqual([{ shadowed: narrow.id, by: broad.id }]);
  });

  it.each([
    ['a prefix pattern', { namePattern: 'write_*' }, { namePattern: 'write_file' }, true],
    ['a different server', {}, { serverId: GH }, false],
    ['a different kind', {}, { itemKind: 'prompt' as const }, false],
    [
      'a narrower subject above a broader one',
      { subjectKind: 'role' as const, subjectId: 'viewer' },
      {},
      false,
    ],
    ['an expiring rule above', { expiresAt: 9_999 }, {}, false],
    [
      'a constrained allow above',
      { effect: 'allow' as const, args: [{ op: 'present' as const, ptr: '/x' }] },
      {},
      false,
    ],
    ['disjoint names', { namePattern: 'read_*' }, { namePattern: 'write_*' }, false],
  ])('%s → %s', (_n, a, b, shadowed) => {
    expect(findShadows([rule(a), rule(b)]).length > 0).toBe(shadowed);
  });
});
