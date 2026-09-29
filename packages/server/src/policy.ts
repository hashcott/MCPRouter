import { posix } from 'node:path';
import { z } from 'zod';
import type { ItemKind } from '@mcprouter/core';

/**
 * The policy engine (§11.3): a FIRST-MATCH scan over an ordered in-memory array
 * loaded from Postgres. No parser, no sandbox, no expression language, no boolean
 * combinators, no operator-supplied regex. Policy is default-allow and purely
 * subtractive — grants are the authorization layer, this is not.
 */

const Ptr = z
  .string()
  .max(200)
  .regex(/^(\/(?:[^~/]|~[01])*)*$/, 'an RFC 6901 JSON pointer, e.g. /path or /opts/mode');
const Str = z.string().max(512);

/** The seven argument ops. ANDed on one rule; a missing path or a wrong type FAILS. */
export const ArgConstraint = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('present'), ptr: Ptr }),
  z.strictObject({ op: z.literal('absent'), ptr: Ptr }),
  z.strictObject({ op: z.literal('equals'), ptr: Ptr, value: Str }),
  z.strictObject({ op: z.literal('oneOf'), ptr: Ptr, values: z.array(Str).min(1).max(64) }),
  /** A STRING prefix. Not a path check — use pathUnder for paths. */
  z.strictObject({ op: z.literal('prefix'), ptr: Ptr, value: Str }),
  /** POSIX containment, LEXICAL only. */
  z.strictObject({ op: z.literal('pathUnder'), ptr: Ptr, value: Str }),
  z.strictObject({ op: z.literal('maxLen'), ptr: Ptr, n: z.int().min(0).max(1_000_000) }),
]);
export type ArgConstraint = z.infer<typeof ArgConstraint>;
export const ArgConstraints = z.array(ArgConstraint).max(16);

export type Role = 'viewer' | 'operator' | 'admin';
export const ROLES: readonly Role[] = ['viewer', 'operator', 'admin'];

export type CompiledRule = {
  id: string;
  seq: number;
  subjectKind: 'any' | 'role' | 'api_key';
  subjectId: string | null;
  serverId: string;
  /** Rendered from the FK join, for sentences and audit only — never matched on. */
  serverSlug: string;
  itemKind: ItemKind;
  namePattern: string;
  effect: 'allow' | 'deny';
  args: ArgConstraint[];
  note: string | null;
  /** Epoch ms, or null. */
  expiresAt: number | null;
};

/**
 * Who is calling, as policy sees it. `role` is the OWNING user's role, resolved at
 * authenticate for machine principals too (§11.3 HIGH): a viewer's own key must match
 * a `role viewer → deny` rule, and a demotion must reach keys minted before it.
 */
export type PolicySubject = { role: Role; keyId: string };

export type PolicyInput = {
  subject: PolicySubject;
  serverId: string;
  kind: ItemKind;
  bare: string;
  args: unknown;
  now: number;
};

/** Never the argument VALUE: arguments are not logged. */
export type DenyReason = { k: 'selector' } | { k: 'args'; ptr: string; op: ArgConstraint['op'] };

export type PolicyDecision =
  | { effect: 'allow'; ruleId: string | null }
  | { effect: 'deny'; ruleId: string; note: string | null; reason: DenyReason };

/**
 * `*` is the only metacharacter. Iterative with single-star backtracking: linear in
 * practice, bounded by the 128-char pattern CHECK — no regex, so no ReDoS.
 */
export function globMatch(pattern: string, s: string): boolean {
  let p = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === s[i]) {
      p += 1;
      i += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      mark = i;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      i = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * RFC 6901 walk with Object.hasOwn at every step: `/__proto__/x` or `/constructor`
 * can never reach the prototype chain. Returns found:false for any missing step.
 */
export function pointerGet(root: unknown, ptr: string): { found: boolean; value?: unknown } {
  if (ptr === '') return { found: true, value: root };
  let cur: unknown = root;
  for (const raw of ptr.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key))
      return { found: false };
    cur = (cur as Record<string, unknown>)[key];
  }
  return { found: true, value: cur };
}

/**
 * ponytail: lexical containment only; symlink resolution is the upstream server's
 * job, not the gateway's. Relative paths are refused (their meaning depends on an
 * upstream cwd we cannot see), as are NUL, backslash and any `..` segment.
 */
export function pathUnder(value: string, base: string): boolean {
  if (!value.startsWith('/') || !base.startsWith('/')) return false;
  if (/[\0\\]/.test(value) || value.split('/').includes('..')) return false;
  const v = posix.normalize(value);
  const b = posix.normalize(base).replace(/\/+$/, '') || '/';
  return b === '/' ? true : v === b || v.startsWith(`${b}/`);
}

function holds(c: ArgConstraint, args: unknown): boolean {
  const at = pointerGet(args, c.ptr);
  switch (c.op) {
    case 'present':
      return at.found;
    case 'absent':
      return !at.found;
    default: {
      // Every other op needs a string there: `{"path": ["/tmp","/etc"]}` must not slip past.
      if (!at.found || typeof at.value !== 'string') return false;
      const v = at.value;
      if (c.op === 'equals') return v === c.value;
      if (c.op === 'oneOf') return c.values.includes(v);
      if (c.op === 'prefix') return v.startsWith(c.value);
      if (c.op === 'pathUnder') return pathUnder(v, c.value);
      return v.length <= c.n;
    }
  }
}

function subjectMatches(r: CompiledRule, s: PolicySubject): boolean {
  if (r.subjectKind === 'any') return true;
  if (r.subjectKind === 'role') return s.role === r.subjectId;
  return s.keyId === r.subjectId;
}

/** FIRST MATCH on the pre-ordered array; implicit final allow (grants already default-deny). */
export function evaluate(rules: readonly CompiledRule[], i: PolicyInput): PolicyDecision {
  for (const r of rules) {
    if (r.expiresAt !== null && i.now >= r.expiresAt) continue;
    if (r.serverId !== i.serverId || r.itemKind !== i.kind) continue;
    if (!subjectMatches(r, i.subject) || !globMatch(r.namePattern, i.bare)) continue;
    if (r.effect === 'deny')
      return { effect: 'deny', ruleId: r.id, note: r.note, reason: { k: 'selector' } };
    const failed = r.args.find((c) => !holds(c, i.args));
    if (failed === undefined) return { effect: 'allow', ruleId: r.id };
    // An allow whose constraints fail is a deny — fail closed, never "try the next rule".
    return {
      effect: 'deny',
      ruleId: r.id,
      note: r.note,
      reason: { k: 'args', ptr: failed.ptr, op: failed.op },
    };
  }
  return { effect: 'allow', ruleId: null };
}

export type RuleRow = {
  id: string;
  seq: number;
  enabled: boolean;
  subjectKind: string;
  subjectId: string | null;
  serverId: string;
  serverSlug: string;
  itemKind: string;
  namePattern: string;
  effect: string;
  args: unknown;
  note: string | null;
  expiresAt: Date | null;
};

/**
 * Rows → rules, in seq order, disabled rows dropped. A row that fails validation
 * becomes an unconditional DENY on its selector: skipping a broken ALLOW-with-
 * constraints would drop its constraints and fail open.
 */
export function compileRules(rows: readonly RuleRow[]): {
  rules: CompiledRule[];
  broken: string[];
} {
  const broken: string[] = [];
  const rules = [...rows]
    .filter((r) => r.enabled)
    .sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1))
    .map((r): CompiledRule => {
      const args = ArgConstraints.safeParse(r.args);
      const shapeOk =
        args.success &&
        ['any', 'role', 'api_key'].includes(r.subjectKind) &&
        ['tool', 'prompt', 'resource'].includes(r.itemKind) &&
        ['allow', 'deny'].includes(r.effect);
      if (!shapeOk) broken.push(r.id);
      return {
        id: r.id,
        seq: r.seq,
        subjectKind: r.subjectKind as CompiledRule['subjectKind'],
        subjectId: r.subjectId,
        serverId: r.serverId,
        serverSlug: r.serverSlug,
        itemKind: (['tool', 'prompt', 'resource'].includes(r.itemKind)
          ? r.itemKind
          : 'tool') as ItemKind,
        namePattern: r.namePattern,
        effect: shapeOk ? (r.effect as 'allow' | 'deny') : 'deny',
        args: shapeOk && args.success ? args.data : [],
        note: r.note,
        expiresAt: r.expiresAt === null ? null : r.expiresAt.getTime(),
      };
    });
  return { rules, broken };
}

const OPS: Record<ArgConstraint['op'], (c: ArgConstraint) => string> = {
  present: (c) => `${c.ptr} is present`,
  absent: (c) => `${c.ptr} is absent`,
  equals: (c) => `${c.ptr} equals "${(c as { value: string }).value}"`,
  oneOf: (c) =>
    `${c.ptr} is one of ${(c as { values: string[] }).values.map((v) => `"${v}"`).join(', ')}`,
  prefix: (c) =>
    `${c.ptr} starts with "${(c as { value: string }).value}" (a string prefix, not a path check)`,
  pathUnder: (c) =>
    `${c.ptr} is a path under ${(c as { value: string }).value} (lexical: symlinks are not resolved)`,
  maxLen: (c) => `${c.ptr} is at most ${(c as { n: number }).n} characters`,
};

/**
 * Every rule as ONE readable sentence (§11.3 "explain is mandatory"): an engine that
 * cannot explain itself gets switched off.
 */
export function describeRule(r: CompiledRule): string {
  const who =
    r.subjectKind === 'any'
      ? 'Anyone'
      : r.subjectKind === 'role'
        ? `Anyone with role ${r.subjectId}`
        : `API key ${r.subjectId}`;
  const what = `${r.itemKind} ${r.namePattern === '*' ? 'items' : `"${r.namePattern}"`} on ${r.serverSlug}`;
  const until = r.expiresAt === null ? '' : `, until ${new Date(r.expiresAt).toISOString()}`;
  const why = r.note === null ? '' : ` — "${r.note}"`;
  // §11.4 lets prompt/resource policy wait — "with the ceiling written down". Here it is.
  const ceiling =
    r.itemKind === 'tool' ? '' : ' [NOT ENFORCED: only tools/call is policy-gated yet]';
  if (r.effect === 'deny') return `${who} is DENIED every ${what}${until}${why}.${ceiling}`;
  if (r.args.length === 0) return `${who} is ALLOWED every ${what}${until}${why}.${ceiling}`;
  return `${who} is ALLOWED ${what} only when ${r.args.map((c) => OPS[c.op](c)).join(' and ')}; otherwise DENIED${until}${why}.${ceiling}`;
}

function patternCovers(a: string, b: string): boolean {
  if (a === '*' || a === b) return true;
  // `read_*` covers `read_file` and `read_x*`; a pattern with an inner star is not reasoned about.
  if (a.endsWith('*') && !a.slice(0, -1).includes('*')) return b.startsWith(a.slice(0, -1));
  return false;
}

/**
 * Shadow detection (§11.3): with first match, a broad UNCONDITIONAL rule above a
 * narrower one silently disables it — above all an `allow` sitting over the rule that
 * carried the constraints. O(n²) over a few hundred rows.
 */
export function findShadows(
  rules: readonly CompiledRule[],
): { shadowed: string; by: string; until: number | null }[] {
  const out: { shadowed: string; by: string; until: number | null }[] = [];
  rules.forEach((b, j) => {
    // ANY rule whose selector covers b ends the scan before b — including a constrained
    // allow (its failed constraints deny, they do not fall through). An expiring one
    // shadows b until it expires.
    const a = rules
      .slice(0, j)
      .find(
        (x) =>
          x.serverId === b.serverId &&
          x.itemKind === b.itemKind &&
          (x.subjectKind === 'any' ||
            (x.subjectKind === b.subjectKind && x.subjectId === b.subjectId)) &&
          patternCovers(x.namePattern, b.namePattern),
      );
    if (a !== undefined) out.push({ shadowed: b.id, by: a.id, until: a.expiresAt });
  });
  return out;
}
