import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { Logger } from 'pino';
import { eq } from 'drizzle-orm';
import { schema, type Db, type Principal } from '@mcprouter/core';
import { parseGrant, toPermissions, type Grant } from './grant.js';
import { ROLES, type Role } from './policy.js';

/** The unscoped grant. Scoped keys are minted with toPermissions({ kind: 'groups' | 'servers', … }). */
export const KEY_GRANT_ALL = toPermissions({ kind: 'all' });

/**
 * §5.2 point 2: a machine credential is never admin, as a TYPE — writing
 * `isAdmin: true` (or `isAdmin: someRole === 'admin'`) on this path fails to compile.
 */
export type MachinePrincipal = Principal & { isAdmin: false };

export type KeyAuth = {
  principal: MachinePrincipal;
  keyId: string;
  grant: Grant;
  /**
   * The OWNING user's role, read at every authenticate — never stamped on the key at
   * mint time (§11.3 HIGH): a viewer's key matches `role viewer` rules, and a
   * demotion reaches keys minted before it.
   */
  role: Role;
};

export type AuthDeps = {
  db: Db;
  secret: string;
  baseURL: string;
  log: Logger;
  /**
   * Who may tell us the client IP. With neither set, NO header is trusted: sign-in is
   * rate-limited in one shared bucket — a forged X-Forwarded-For buys no extra guesses.
   */
  trustedProxies?: readonly string[] | undefined;
  clientIpHeader?: string | undefined;
};

/** better-auth is configuration, not code (§13 P1). We store, hash and look up nothing ourselves. */
export function createAuth({ db, secret, baseURL, log, trustedProxies, clientIpHeader }: AuthDeps) {
  return betterAuth({
    secret,
    baseURL,
    basePath: '/api/auth',
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    // Humans sign in to the console. Sign-UP stays closed: people are created by an admin
    // (or claim the one bootstrap token on a fresh install), never by a stranger (P1c R2).
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    // Always on (better-auth's default is production-only). Sign-in: 3 tries / 10 s per IP.
    // ponytail: in-memory per replica; move to storage 'database' when running several.
    rateLimit: { enabled: true },
    advanced: {
      ipAddress:
        trustedProxies !== undefined && trustedProxies.length > 0
          ? { trustedProxies: [...trustedProxies] }
          : clientIpHeader !== undefined
            ? { ipAddressHeaders: [clientIpHeader] }
            : // A header nobody sends: no client IP is believed from the request.
              { ipAddressHeaders: ['x-mcprouter-untrusted'] },
    },
    user: {
      additionalFields: {
        // input:false — otherwise a sign-up payload could set role:'admin' (§5.3).
        role: { type: 'string', input: false, defaultValue: 'viewer', required: true },
      },
    },
    // Invalid keys are ordinary traffic and better-auth logs each one at ERROR.
    logger: { log: (level, message) => log.debug({ evt: 'auth.lib', level }, message) },
    plugins: [
      apiKey({
        // §5.2 tripwire. true would mint a session for every key, and an admin's key would be admin.
        enableSessionForAPIKeys: false,
        // The key's owner can write metadata over HTTP; the grant lives in server-only `permissions`.
        enableMetadata: false,
        // The default is 10 requests per DAY.
        rateLimit: { enabled: false },
        defaultPrefix: 'mcpr_',
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const BEARER = /^Bearer\s+(\S+)$/i;

export async function authenticateKey(
  auth: Auth,
  db: Db,
  authorization: string | undefined,
): Promise<KeyAuth | null> {
  const key = BEARER.exec(authorization ?? '')?.[1];
  if (key === undefined) return null;
  // Returns {valid:false}, never throws, for an unknown/disabled/expired key.
  const r = await auth.api.verifyApiKey({ body: { key } });
  if (!r.valid || r.key === null) return null;
  // Parsed on every read, fail-closed (§5.2): a grant this build does not know denies.
  const grant = parseGrant(r.key.permissions);
  if (grant === null) return null;
  const [owner] = await db
    .select({ role: schema.user.role })
    .from(schema.user)
    .where(eq(schema.user.id, r.key.referenceId));
  // No owner, or a role this build does not know: fail closed.
  const role = ROLES.find((x) => x === owner?.role);
  if (role === undefined) return null;
  // §5.2: a machine credential is never admin, whatever its owner's role.
  return { principal: { id: r.key.referenceId, isAdmin: false }, keyId: r.key.id, grant, role };
}

/** better-auth's own password hash, so accounts we insert verify on sign-in. */
export function passwordHasher(auth: Auth): (password: string) => Promise<string> {
  return async (password) => (await auth.$context).password.hash(password);
}

export type SessionUser = { id: string; email: string; name: string; role: Role };

/**
 * The console's principal: a better-auth SESSION only. API keys never authenticate a
 * console route (§5.2: a key never implies a human, let alone an admin) — the plugin
 * mints no session for them (`enableSessionForAPIKeys: false`).
 */
export async function sessionUser(auth: Auth, headers: Headers): Promise<SessionUser | null> {
  const s = await auth.api.getSession({ headers });
  if (s === null) return null;
  const role = ROLES.find((x) => x === (s.user as { role?: unknown }).role);
  if (role === undefined) return null; // an unknown role is no role: fail closed
  return { id: s.user.id, email: s.user.email, name: s.user.name, role };
}
