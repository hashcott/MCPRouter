import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ToolDecision } from '@mcprouter/core';
import { ALLOW_ALL_GATE, denyText, makeGate } from './gate.js';
import type { CompiledRule } from './policy.js';

const FS = '00000000-0000-4000-8000-0000000000f5';
const tool: ToolDecision = {
  sel: { serverName: 'fs', tools: 'all', prompts: 'all', resources: 'all' },
  bare: 'write_file',
  server: 'fs',
};
const deny: CompiledRule = {
  id: 'r1',
  seq: 10,
  subjectKind: 'role',
  subjectId: 'viewer',
  serverId: FS,
  serverSlug: 'fs',
  itemKind: 'tool',
  namePattern: 'write_*',
  effect: 'deny',
  args: [],
  note: 'viewers read only',
  expiresAt: null,
};
const decode = (b: Uint8Array) => JSON.parse(Buffer.from(b).toString('utf8'));

describe('makeGate', () => {
  const effects: string[] = [];
  const gate = (role: 'viewer' | 'operator') =>
    makeGate({
      rules: [deny],
      serverIdOf: (n) => (n === 'fs' ? FS : undefined),
      subject: { role, keyId: 'k1' },
      onDecision: (e) => effects.push(e),
    });

  it('an allowed call is stamped, and the Decision carries exactly the checked bytes', () => {
    const r = gate('operator')(tool, { path: '/srv/x', n: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.decision.tool).toBe(tool);
    expect(decode(r.decision.bytes)).toEqual({ path: '/srv/x', n: 1 });
    expect(Object.isFrozen(r.decision)).toBe(true);
  });

  it('a denied call gets no Decision at all — only the rule and its note', () => {
    expect(gate('viewer')(tool, {})).toEqual({
      ok: false,
      ruleId: 'r1',
      note: 'viewers read only',
      reason: { k: 'selector' },
    });
  });

  it('a server the snapshot cannot name is denied (fail closed)', () => {
    const g = makeGate({
      rules: [],
      serverIdOf: () => undefined,
      subject: { role: 'admin', keyId: 'k' },
    });
    expect(g(tool, {}).ok).toBe(false);
  });

  it('every decision is counted', () => {
    effects.length = 0;
    gate('operator')(tool, {});
    gate('viewer')(tool, {});
    expect(effects).toEqual(['allow', 'deny']);
  });

  it('ALLOW_ALL_GATE stamps too — it exists to be passed EXPLICITLY', () => {
    const r = ALLOW_ALL_GATE(tool, { a: 1 });
    expect(r.ok && decode(r.decision.bytes)).toEqual({ a: 1 });
  });

  it('the caller reads the operator note, prefixed so the model knows it was policy', () => {
    expect(denyText('use the queue')).toBe('Denied by policy: use the queue');
    expect(denyText(null)).toBe('Denied by policy.');
  });
});

describe('the seam is structural (§11.4)', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return sources(p);
      return /\.ts$/.test(f) && !/\.(test|itest)\.ts$/.test(f) ? [p] : [];
    });

  it('in server and cli code, ONLY gate.ts mints a Decision', () => {
    const minting = [...sources(join(root, 'server/src')), ...sources(join(root, 'cli/src'))]
      .filter((p) => readFileSync(p, 'utf8').includes('stampDecision('))
      .map((p) => relative(root, p));
    expect(minting).toEqual(['server/src/gate.ts']);
  });

  it('server and cli code never call the policy-free engine.callTool', () => {
    const offenders = [
      ...sources(join(root, 'server/src')),
      ...sources(join(root, 'cli/src')),
    ].filter((p) => /\.callTool\(\{/.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
