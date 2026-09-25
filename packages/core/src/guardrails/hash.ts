import { createHash } from 'node:crypto';

// ponytail: determinism-only, NOT RFC 8785. We only ever compare our hash with our hash.
//           Switch to canonicalize@2 if a hash ever crosses a process boundary we do not own.

/** Removed to derive the shape hash. Everything else — including keys nobody listed — is shape. */
const PROSE_KEYS = new Set(['description', 'title', 'annotations']);

/** Deeper than any sane schema; deeper than this is a defect, never a stack overflow. */
export const MAX_DEF_DEPTH = 64;

class TooDeep extends Error {}

/**
 * Recursive key sort + JSON. NFC applies to string VALUES only: keys stay as
 * received, so a homoglyph property name is a change rather than a fold. NFKC is
 * refused — it folds ligatures and full-width forms, which change the rendering
 * and are a known concealment vector.
 */
export function canonical(v: unknown, depth = 0): string {
  if (depth > MAX_DEF_DEPTH) throw new TooDeep();
  if (typeof v === 'string') return JSON.stringify(v.normalize('NFC'));
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x, depth + 1)).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k], depth + 1)}`).join(',')}}`;
}

export type DefHashes = { defHash: string; shapeHash: string };

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The WHOLE object as received, and its shape by DELETING prose keys (§11.2). */
export function hashDefinition(def: object): DefHashes | 'defect' {
  try {
    const shape = Object.fromEntries(Object.entries(def).filter(([k]) => !PROSE_KEYS.has(k)));
    return { defHash: sha(canonical(def)), shapeHash: sha(canonical(shape)) };
  } catch (err) {
    if (err instanceof TooDeep) return 'defect';
    throw err;
  }
}
