import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Fixed forever: changing any of these makes every stored secret unreadable.
const ALG = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const SECRET_SCOPES = [
  'server_env',
  'server_header',
  'server_oauth_client',
  'credential',
  'upstream_access',
  'upstream_refresh',
] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

export type Keyring = {
  /** Version of the first entry in MCPR_SECRET_KEYS; every seal uses it. */
  readonly active: number;
  readonly keys: ReadonlyMap<number, Buffer>;
};

export type SecretIdentity = {
  id: string;
  scope: SecretScope;
  serverId: string | null;
  userId: string | null;
  label: string;
};

export type SealedSecret = SecretIdentity & {
  keyVersion: number;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
};

/** Messages describe the shape that was wrong, never the value. */
export class KeyringError extends Error {
  override name = 'KeyringError';
}

export class SecretOpenError extends Error {
  override name = 'SecretOpenError';
  constructor(
    readonly secretId: string,
    readonly reason: 'unknown-key' | 'auth-failed',
  ) {
    super(`secret ${secretId} cannot be opened: ${reason}`);
  }
}

// Version capped at 4 digits: it lands in a smallint column.
const ENTRY = /^v([1-9][0-9]{0,3}):([A-Za-z0-9_-]+)$/;

export function parseKeyring(raw: string | undefined): Keyring {
  if (raw === undefined || raw.trim() === '') throw new KeyringError('not set');
  const keys = new Map<number, Buffer>();
  for (const entry of raw.split(',')) {
    const m = ENTRY.exec(entry.trim());
    if (m === null) throw new KeyringError('each entry must be v<N>:<base64url of 32 bytes>');
    const version = Number(m[1]);
    const key = Buffer.from(m[2] ?? '', 'base64url');
    if (key.length !== KEY_BYTES) {
      throw new KeyringError(`v${version} must decode to exactly ${KEY_BYTES} bytes`);
    }
    if (keys.has(version)) throw new KeyringError(`v${version} appears twice`);
    keys.set(version, key);
  }
  const [active] = keys.keys();
  return { active: active as number, keys };
}

export function generateKeyLine(): string {
  return `MCPR_SECRET_KEYS=v1:${randomBytes(KEY_BYTES).toString('base64url')}`;
}

/**
 * The AAD is this FROZEN field list, never "the row's columns" (§11.7): a
 * column added to `secrets` later must not change what a stored ciphertext is
 * bound to, or every upstream silently loses its credentials on the next boot.
 */
function aad(s: SecretIdentity & { keyVersion: number }): Buffer {
  return Buffer.from(
    [s.id, s.scope, s.serverId ?? '', s.userId ?? '', s.label, String(s.keyVersion)].join('\x1f'),
    'utf8',
  );
}

export function seal(kr: Keyring, ident: SecretIdentity, plaintext: string): SealedSecret {
  const keyVersion = kr.active;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, kr.keys.get(keyVersion) as Buffer, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad({ ...ident, keyVersion }));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    id: ident.id,
    scope: ident.scope,
    serverId: ident.serverId,
    userId: ident.userId,
    label: ident.label,
    keyVersion,
    iv,
    ciphertext,
    tag: cipher.getAuthTag(),
  };
}

export function open(kr: Keyring, s: SealedSecret): string {
  const key = kr.keys.get(s.keyVersion);
  if (key === undefined) throw new SecretOpenError(s.id, 'unknown-key');
  try {
    const decipher = createDecipheriv(ALG, key, s.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(s));
    decipher.setAuthTag(s.tag);
    return Buffer.concat([decipher.update(s.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, moved row, flipped byte or short tag all look the same from here.
    throw new SecretOpenError(s.id, 'auth-failed');
  }
}
