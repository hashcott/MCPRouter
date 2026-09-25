import { describe, expect, it } from 'vitest';
import { canSee, checkGrant, parseGrant, toPermissions, type Grant } from './grant.js';
import type { Route } from './scope.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const G = '00000000-0000-4000-8000-0000000000aa';
const H = '00000000-0000-4000-8000-0000000000bb';

const route = (serverIds: string[], groupId?: string): Route => ({
  scope: { key: 'k', servers: [], flatten: false },
  serverIds,
  groupId,
  label: 'x',
});

describe('parseGrant', () => {
  it.each([
    [{ mcp: ['all'] }, { kind: 'all' }],
    [{ groups: [G] }, { kind: 'groups', ids: [G] }],
    [{ servers: [A, B] }, { kind: 'servers', ids: [A, B] }],
  ])('parses %j', (raw, grant) => expect(parseGrant(raw)).toEqual(grant));

  it.each([
    ['null', null],
    ['empty object', {}],
    ['unknown mcp value', { mcp: ['read'] }],
    ['two kinds at once', { mcp: ['all'], groups: [G] }],
    ['an empty list', { groups: [] }],
    ['a slug instead of an id', { servers: ['fs'] }],
    ['an extra key', { servers: [A], note: ['x'] }],
  ])('fails closed on %s', (_n, raw) => expect(parseGrant(raw)).toBeNull());

  it('toPermissions round-trips', () => {
    for (const g of [
      { kind: 'all' },
      { kind: 'groups', ids: [G] },
      { kind: 'servers', ids: [A] },
    ] as Grant[]) {
      expect(parseGrant(toPermissions(g))).toEqual(g);
    }
  });
});

// The exhaustive truth table (§4.2). Routes: all = {A,B}; group G = {A,B}; group H = {A};
// empty group E; server A.
describe('checkGrant', () => {
  const all = route([A, B]);
  const groupG = route([A, B], G);
  const groupH = route([A], H);
  const empty = route([], '00000000-0000-4000-8000-0000000000ee');
  const serverA = route([A]);

  it.each([
    ['all', { kind: 'all' }, all, 'ok'],
    ['all', { kind: 'all' }, groupG, 'ok'],
    ['all', { kind: 'all' }, serverA, 'ok'],
    ['groups[G] on G', { kind: 'groups', ids: [G] }, groupG, 'ok'],
    ['groups[G] on H', { kind: 'groups', ids: [G] }, groupH, 'insufficient'],
    ['groups[G,H] on H', { kind: 'groups', ids: [G, H] }, groupH, 'ok'],
    ['groups[G] on all (R3)', { kind: 'groups', ids: [G] }, all, 'insufficient'],
    ['groups[G] on server A (R3)', { kind: 'groups', ids: [G] }, serverA, 'insufficient'],
    ['servers[A] on server A', { kind: 'servers', ids: [A] }, serverA, 'ok'],
    ['servers[A] on H={A}', { kind: 'servers', ids: [A] }, groupH, 'ok'],
    [
      'servers[A] on G={A,B} — containment, not partial',
      { kind: 'servers', ids: [A] },
      groupG,
      'insufficient',
    ],
    ['servers[A] on all={A,B}', { kind: 'servers', ids: [A] }, all, 'insufficient'],
    ['servers[A,B] on all', { kind: 'servers', ids: [A, B] }, all, 'ok'],
    ['servers[A] on an empty group', { kind: 'servers', ids: [A] }, empty, 'ok'],
    ['groups[G] on an empty group', { kind: 'groups', ids: [G] }, empty, 'insufficient'],
  ] as const)('%s → %s', (_n, grant, r, expected) => {
    expect(checkGrant(grant as Grant, r)).toBe(expected);
  });
});

// §4.2: a group the principal cannot see answers the same 404 as a group that does not exist.
describe('canSee', () => {
  const groupG = route([A, B], G);
  const groupH = route([A], H);
  const empty = route([], '00000000-0000-4000-8000-0000000000ee');

  it.each([
    ['all on any group', { kind: 'all' }, groupG, true],
    ['groups[G] on G', { kind: 'groups', ids: [G] }, groupG, true],
    ['groups[G] on H — another group is invisible', { kind: 'groups', ids: [G] }, groupH, false],
    [
      'servers[A] on G={A,B} — sees a member: visible, then 403 on containment',
      { kind: 'servers', ids: [A] },
      groupG,
      true,
    ],
    [
      'servers[B] on H={A} — no member in reach: invisible',
      { kind: 'servers', ids: [B] },
      groupH,
      false,
    ],
    ['servers[A] on an empty group', { kind: 'servers', ids: [A] }, empty, true],
    ['groups[G] on an empty other group', { kind: 'groups', ids: [G] }, empty, false],
  ] as const)('%s → %s', (_n, grant, r, expected) => {
    expect(canSee(grant as Grant, r)).toBe(expected);
  });

  it.each([
    ['groups[G] on /mcp', { kind: 'groups', ids: [G] }, route([A, B])],
    ['servers[B] on server A', { kind: 'servers', ids: [B] }, route([A])],
  ] as const)(
    'non-group routes are always visible (%s): the answer there is 403, not 404',
    (_n, grant, r) => {
      expect(canSee(grant as Grant, r)).toBe(true);
    },
  );
});
