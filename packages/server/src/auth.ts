import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { Logger } from 'pino';
import { z } from 'zod';
import { schema, type Db, type Principal } from '@mcprouter/core';

/** The only grant P1 mints. P2 widens `Grant` to groups/servers. */
export const KEY_GRANT_ALL = { mcp: ['all'] };

/** Parsed on every read and fail-closed (§5.2): anything P1 does not know denies. */
const Grant = z.strictObject({ mcp: z.tuple([z.literal('all')]) });

/**
 * §5.2 point 2: a machine credential is never admin, as a TYPE — writing
 * `isAdmin: true` (or `isAdmin: someRole === 'admin'`) on this path fails to compile.
 */
export type MachinePrincipal = Principal & { isAdmin: false };

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
): Promise<MachinePrincipal | null> {
  const key = BEARER.exec(authorization ?? '')?.[1];
  if (key === undefined) return null;
  // Returns {valid:false}, never throws, for an unknown/disabled/expired key.
  const r = await auth.api.verifyApiKey({ body: { key } });
  if (!r.valid || r.key === null) return null;
  if (!Grant.safeParse(r.key.permissions).success) return null;
  // §5.2: a machine credential is never admin, whatever its owner's role.
  return { id: r.key.referenceId, isAdmin: false };
}
