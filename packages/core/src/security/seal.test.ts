import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateKeyLine,
  KeyringError,
  open,
  parseKeyring,
  seal,
  SecretOpenError,
  type SecretIdentity,
} from './seal.js';

const k = (byte: number) => Buffer.alloc(32, byte).toString('base64url');
const KR1 = parseKeyring(`v1:${k(1)}`);
const KR21 = parseKeyring(`v2:${k(2)},v1:${k(1)}`);

const ident = (): SecretIdentity => ({
  id: randomUUID(),
  scope: 'server_env',
  serverId: randomUUID(),
  userId: null,
  label: 'API_KEY',
});

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof SecretOpenError) return err.reason;
    throw err;
  }
  throw new Error('did not throw');
}

describe('parseKeyring', () => {
  it('takes the first entry as active and keeps every key', () => {
    expect(KR21.active).toBe(2);
    expect([...KR21.keys.keys()]).toEqual([2, 1]);
  });

  it('tolerates spaces around entries, as pasted from a .env', () => {
    expect(parseKeyring(` v2:${k(2)} , v1:${k(1)} `).active).toBe(2);
  });

  it.each([
    ['unset', undefined, /not set/],
    ['empty', '  ', /not set/],
    ['no version', k(1), /v<N>:<base64url/],
    ['v0', `v0:${k(1)}`, /v<N>:<base64url/],
    ['trailing comma', `v1:${k(1)},`, /v<N>:<base64url/],
    [
      'short key',
      `v1:${Buffer.alloc(16).toString('base64url')}`,
      /v1 must decode to exactly 32 bytes/,
    ],
    ['duplicate version', `v1:${k(1)},v1:${k(2)}`, /v1 appears twice/],
  ])('rejects %s', (_name, raw, message) => {
    expect(() => parseKeyring(raw)).toThrow(KeyringError);
    expect(() => parseKeyring(raw)).toThrow(message);
  });

  it('never echoes key material in an error', () => {
    const short = Buffer.alloc(16, 7).toString('base64url');
    expect(() => parseKeyring(`v1:${short}`)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(short) }),
    );
  });

  it('generateKeyLine produces a line that parses back', () => {
    const line = generateKeyLine();
    expect(line).toMatch(/^MCPR_SECRET_KEYS=v1:[A-Za-z0-9_-]{43}$/);
    expect(parseKeyring(line.slice('MCPR_SECRET_KEYS='.length)).active).toBe(1);
  });
});

describe('seal / open', () => {
  it('round-trips, including non-ASCII', () => {
    const s = seal(KR1, ident(), 'sk-live-ünïcødé-🔑');
    expect(open(KR1, s)).toBe('sk-live-ünïcødé-🔑');
    expect(s.iv).toHaveLength(12);
    expect(s.tag).toHaveLength(16);
    expect(s.keyVersion).toBe(1);
  });

  it('uses a fresh iv every time', () => {
    const id = ident();
    expect(seal(KR1, id, 'x').iv.equals(seal(KR1, id, 'x').iv)).toBe(false);
  });

  it.each([
    ['id', { id: randomUUID() }],
    ['scope', { scope: 'server_header' as const }],
    ['serverId', { serverId: randomUUID() }],
    ['userId', { userId: 'someone-else' }],
    ['label', { label: 'OTHER_KEY' }],
  ])('a ciphertext moved to another %s does not open', (_field, change) => {
    const s = seal(KR1, ident(), 'sk-live-123');
    expect(reason(() => open(KR1, { ...s, ...change }))).toBe('auth-failed');
  });

  it('a relabelled keyVersion does not open', () => {
    const s = seal(KR21, ident(), 'sk-live-123');
    expect(reason(() => open(KR21, { ...s, keyVersion: 1 }))).toBe('auth-failed');
  });

  it('seals under the active key and still opens rows sealed under an older one', () => {
    const old = seal(KR1, ident(), 'old');
    expect(open(KR21, old)).toBe('old');
    expect(seal(KR21, ident(), 'new').keyVersion).toBe(2);
  });

  it('reports unknown-key when the row names a key the keyring no longer has', () => {
    const s = seal(KR21, ident(), 'x');
    expect(reason(() => open(KR1, s))).toBe('unknown-key');
  });

  it('rejects a flipped ciphertext byte and a truncated tag', () => {
    const s = seal(KR1, ident(), 'sk-live-123');
    const flipped = Buffer.from(s.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(reason(() => open(KR1, { ...s, ciphertext: flipped }))).toBe('auth-failed');
    expect(reason(() => open(KR1, { ...s, tag: s.tag.subarray(0, 4) }))).toBe('auth-failed');
  });

  it('names the secret, never the plaintext, in the error', () => {
    const s = seal(KR1, ident(), 'sk-live-123');
    try {
      open(KR1, { ...s, label: 'X' });
    } catch (err) {
      expect(String(err)).toContain(s.id);
      expect(String(err)).not.toContain('sk-live-123');
    }
  });
});
