import { readFileSync } from 'node:fs';
import { z } from 'zod';

const SECRET_KEYS = ['AUTH_SECRET', 'DATABASE_URL'] as const;

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
  PUBLIC_URL: z.url({ message: 'must be an absolute URL, e.g. https://hub.example.com' }),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FILE: z.string().optional(),
  MIGRATE_ON_BOOT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
});

export interface Config {
  readonly databaseUrl: string;
  readonly authSecret: string;
  readonly publicUrl: URL;
  readonly port: number;
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly logFile: string | undefined;
  readonly migrateOnBoot: boolean;
  readonly shutdownTimeoutMs: number;
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
    publicUrl: new URL(v.PUBLIC_URL),
    port: v.PORT,
    logLevel: v.LOG_LEVEL,
    logFile: v.LOG_FILE,
    migrateOnBoot: v.MIGRATE_ON_BOOT,
    shutdownTimeoutMs: v.SHUTDOWN_TIMEOUT_MS,
    toJSON() {
      return {
        databaseUrl: '[redacted]',
        authSecret: '[redacted]',
        publicUrl: this.publicUrl.href,
        port: this.port,
        logLevel: this.logLevel,
        logFile: this.logFile,
        migrateOnBoot: this.migrateOnBoot,
        shutdownTimeoutMs: this.shutdownTimeoutMs,
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
