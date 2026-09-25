import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { Logger } from 'pino';
import { schema, type Db, type Principal } from '@mcprouter/core';
import { parseGrant, toPermissions, type Grant } from './grant.js';

/** The unscoped grant. Scoped keys are minted with toPermissions({ kind: 'groups' | 'servers', … }). */
export const KEY_GRANT_ALL = toPermissions({ kind: 'all' });

/**
 * §5.2 point 2: a machine credential is never admin, as a TYPE — writing
 * `isAdmin: true` (or `isAdmin: someRole === 'admin'`) on this path fails to compile.
 */
export type MachinePrincipal = Principal & { isAdmin: false };

export type KeyAuth = { principal: MachinePrincipal; keyId: string; grant: Grant };

export type AuthDeps = { db: Db; secret: string; baseURL: string; log: Logger };

/** better-auth is configuration, not code (§13 P1). We store, hash and look up nothing ourselves. */
export function createAuth({ db, secret, baseURL, log }: AuthDeps) {
  return betterAuth({
    secret,
    baseURL,
    basePath: '/api/auth',
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    // Humans sign in with the console (P3). Until then users are created by the CLI.
    emailAndPassword: { enabled: false },
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
  // §5.2: a machine credential is never admin, whatever its owner's role.
  return { principal: { id: r.key.referenceId, isAdmin: false }, keyId: r.key.id, grant };
}
