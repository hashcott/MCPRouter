import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type pg from 'pg';
import { Engine } from '@mcprouter/core';
import { FakeUpstream, fakeFactory } from '../../core/test/fake-upstream.js';
import { createApp } from './app.js';
import type { KeyAuth } from './auth.js';
import { parseConfig } from './config.js';
import { createRegistry } from './metrics.js';
import type { CompiledRule } from './policy.js';
import type { Snapshot } from './scope.js';

const FS = '00000000-0000-4000-8000-0000000000f5';
const GH = '00000000-0000-4000-8000-0000000000a1';
const TEAM = '00000000-0000-4000-8000-0000000000e1';

const denyEchoOn = (serverId: string, serverSlug: string): CompiledRule => ({
  id: `deny-${serverSlug}`,
  seq: 10,
  subjectKind: 'any',
  subjectId: null,
  serverId,
  serverSlug,
  itemKind: 'tool',
  namePattern: 'echo',
  effect: 'deny',
  args: [],
  note: `no echo on ${serverSlug}`,
  expiresAt: null,
});

// Two servers exposing the SAME bare tool name, one group holding both: the gate must map
// each resolved name to its own server id, never "the first server" or "the route's first id".
const snapOf = (policy: CompiledRule[], ghId = GH): Snapshot => ({
  servers: [
    { id: FS, slug: 'fs', enabled: true },
    { id: ghId, slug: 'gh', enabled: true },
  ],
  groups: new Map([
    [
      'team',
      {
        id: TEAM,
        members: [
          { serverId: FS, serverSlug: 'fs', tools: 'all', prompts: 'all', resources: 'all' },
          { serverId: ghId, serverSlug: 'gh', tools: 'all', prompts: 'all', resources: 'all' },
        ],
      },
    ],
  ]),
  policy,
});

const key: KeyAuth = {
  principal: { id: 'u1', isAdmin: false },
  keyId: 'k1',
  role: 'operator',
  grant: { kind: 'all' },
};

let engine: Engine;
let current: () => Snapshot = () => snapOf([]);
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  engine = new Engine({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    connect: fakeFactory({
      fs: new FakeUpstream('fs', [{ name: 'echo', handler: () => 'fs echo' }]),
      gh: new FakeUpstream('gh', [{ name: 'echo', handler: () => 'gh echo' }]),
    }),
  });
  await engine.applyConfig(
    ['fs', 'gh'].map((name) => ({
      name,
      enabled: true,
      credentialMode: 'shared' as const,
      type: 'stdio' as const,
      command: 'x',
    })),
  );
  await vi.waitFor(() => expect(engine.status().every((s) => s.state === 'ready')).toBe(true));
  const r = parseConfig({
    DATABASE_URL: 'postgres://u:p@localhost:5432/d',
    AUTH_SECRET: 'z'.repeat(32),
    PUBLIC_URL: 'http://localhost:3000',
    MCPR_SECRET_KEYS: `v1:${Buffer.alloc(32, 3).toString('base64url')}`,
  });
  if (!r.ok) throw new Error(r.issues.join(','));
  app = createApp({
    config: r.config,
    log: pino({ level: 'silent' }),
    pool: {} as pg.Pool,
    registry: createRegistry(),
    readiness: { migrationsApplied: true, routesMounted: true },
    mcp: {
      authenticate: async () => key,
      engine,
      snapshot: () => current(),
      timeoutMs: 5_000,
      maxInflight: 8,
      resultMaxBytes: 1_048_576,
      audit: () => {},
      authHandler: async () => new Response(''),
    },
  });
});

afterAll(() => engine.shutdown());

async function call(path: string, name: string): Promise<string> {
  const res = await app.request(path, {
    method: 'POST',
    headers: {
      authorization: 'Bearer x',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {} },
    }),
  });
  const b = (await res.json()) as { result: { content: { text: string }[] } };
  return b.result.content[0]?.text ?? '';
}

describe('the gate maps each resolved name to ITS server id', () => {
  it.each([
    ['/mcp', 'a rule on gh denies gh only'],
    ['/mcp/g/team', 'the same inside a two-server group route'],
  ])('%s — %s', async (path) => {
    current = () => snapOf([denyEchoOn(GH, 'gh')]);
    expect(await call(path, 'gh__echo')).toBe('Denied by policy: no echo on gh');
    expect(await call(path, 'fs__echo')).toBe('fs echo');
    current = () => snapOf([denyEchoOn(FS, 'fs')]);
    expect(await call(path, 'fs__echo')).toBe('Denied by policy: no echo on fs');
    expect(await call(path, 'gh__echo')).toBe('gh echo');
  });
});

describe('a slug re-used while a request is in flight', () => {
  it('is denied rather than evaluated against the old server and dispatched to the new one', async () => {
    const NEW_GH = '00000000-0000-4000-8000-0000000000a2';
    let calls = 0;
    // First read (route) sees the old gh; every later read (at gate time) sees gh re-created.
    current = () => (calls++ === 0 ? snapOf([]) : snapOf([denyEchoOn(NEW_GH, 'gh')], NEW_GH));
    expect(await call('/mcp', 'gh__echo')).toBe('Denied by policy.');
  });
});

describe('snapshot age gauge', () => {
  it('reads +Inf before the snapshot was ever confirmed — never "fresh"', async () => {
    const reg = createRegistry({ policyCheckedAt: () => undefined });
    expect(
      await reg.registry.getSingleMetricAsString('mcprouter_policy_snapshot_age_seconds'),
    ).toContain('mcprouter_policy_snapshot_age_seconds +Inf');
  });
});
