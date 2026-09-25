import { z } from 'zod';

/** §6. No '_' at all, so no slug can contain the `__` separator. Mirrored by a DB CHECK. */
export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

const EnvKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const HeaderKey = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);

/** The only thing an env/header value may be once stored: a pointer into `secrets` (§5.4). */
export const SecretRef = z.strictObject({ $secret: z.uuid() });

function configSchema<V extends z.ZodType>(value: V) {
  const http = {
    url: z.url({ protocol: /^https?$/ }),
    headers: z.record(HeaderKey, value).default({}),
  };
  return z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      env: z.record(EnvKey, value).default({}),
      cwd: z.string().min(1).optional(),
    }),
    z.strictObject({ type: z.literal('streamable-http'), ...http }),
    z.strictObject({ type: z.literal('sse'), ...http }),
  ]);
}

/** What a writer hands in. `createServer` seals every value before anything reaches the DB. */
export const PlainServerConfig = configSchema(z.string().min(1));
export type PlainServerConfig = z.infer<typeof PlainServerConfig>;
export type PlainServerConfigInput = z.input<typeof PlainServerConfig>;

/** What `servers.config` holds. */
export const StoredServerConfig = configSchema(SecretRef);
export type StoredServerConfig = z.infer<typeof StoredServerConfig>;
