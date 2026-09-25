import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { generateKeyLine, KeyringError, parseKeyring, type Keyring } from '@mcprouter/core';

const SECRET_KEYS = ['AUTH_SECRET', 'DATABASE_URL', 'MCPR_SECRET_KEYS'] as const;

/** `<VAR>_FILE` support: a mounted-file value wins only when the var itself is absent. */
function withFileFallbacks(
  raw: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out = { ...raw };
  for (const [key, value] of Object.entries(raw)) {
    if (!key.endsWith('_FILE') || value === undefined) continue;
    const target = key.slice(0, -'_FILE'.length);
    if (out[target] !== undefined) continue;
    try {
      out[target] = readFileSync(value, 'utf8').trim();
    } catch {
      out[target] = undefined;
    }
  }
  return out;
}

const Schema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message: 'must be a postgres:// or postgresql:// URL',
    }),
  AUTH_SECRET: z
    .string()
    .min(32, { message: 'must be at least 32 characters — run `mcprouter secret`' }),
  // §5.4: no key, no boot — and never a key file we invent ourselves.
  MCPR_SECRET_KEYS: z
    .string()
    .optional()
    .transform((raw, ctx): Keyring => {
      try {
        return parseKeyring(raw);
      } catch (err) {
        if (!(err instanceof KeyringError)) throw err;
        ctx.addIssue({
          code: 'custom',
          message: `${err.message} — generate one and add it to the environment: ${generateKeyLine()}`,
        });
        return z.NEVER;
      }
    }),
  PUBLIC_URL: z.url({ message: 'must be an absolute URL, e.g. https://hub.example.com' }),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FILE: z.string().optional(),
  MIGRATE_ON_BOOT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
  MCP_CALL_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  MCP_MAX_INFLIGHT: z.coerce.number().int().min(1).default(8),
});

export interface Config {
  readonly databaseUrl: string;
  readonly authSecret: string;
  readonly secretKeys: Keyring;
  readonly publicUrl: URL;
  readonly port: number;
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly logFile: string | undefined;
  readonly migrateOnBoot: boolean;
  readonly shutdownTimeoutMs: number;
  readonly mcpCallTimeoutMs: number;
  readonly maxInflight: number;
  toJSON(): Record<string, unknown>;
}

export type ParseResult = { ok: true; config: Config } | { ok: false; issues: string[] };

export function parseConfig(raw: Record<string, string | undefined>): ParseResult {
  const resolved = withFileFallbacks(raw);
  const parsed = Schema.safeParse(resolved);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const name = String(i.path[0] ?? '(root)');
      return `${name}: ${i.message}`;
    });
    // Deterministic order so the message is diffable in CI logs.
    issues.sort();
    return { ok: false, issues };
  }

  const v = parsed.data;
  const config: Config = {
    databaseUrl: v.DATABASE_URL,
    authSecret: v.AUTH_SECRET,
    secretKeys: v.MCPR_SECRET_KEYS,
    publicUrl: new URL(v.PUBLIC_URL),
    port: v.PORT,
    logLevel: v.LOG_LEVEL,
    logFile: v.LOG_FILE,
    migrateOnBoot: v.MIGRATE_ON_BOOT,
    shutdownTimeoutMs: v.SHUTDOWN_TIMEOUT_MS,
    mcpCallTimeoutMs: v.MCP_CALL_TIMEOUT_MS,
    maxInflight: v.MCP_MAX_INFLIGHT,
    toJSON() {
      return {
        databaseUrl: '[redacted]',
        authSecret: '[redacted]',
        secretKeys: '[redacted]',
        publicUrl: this.publicUrl.href,
        port: this.port,
        logLevel: this.logLevel,
        logFile: this.logFile,
        migrateOnBoot: this.migrateOnBoot,
        shutdownTimeoutMs: this.shutdownTimeoutMs,
        mcpCallTimeoutMs: this.mcpCallTimeoutMs,
        maxInflight: this.maxInflight,
      };
    },
  };
  return { ok: true, config: Object.freeze(config) };
}

/** Boot-time entry point. Prints every issue, prints no values, exits 78 (EX_CONFIG). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = parseConfig(env);
  if (r.ok) return r.config;
  process.stderr.write(`${r.issues.join('\n')}\n`);
  process.exit(78);
}

export { SECRET_KEYS };
