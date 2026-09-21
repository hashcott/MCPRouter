import { pino, destination as fileDestination, type Logger, type DestinationStream } from 'pino';
import { currentContext } from './context.js';

export type { Logger };

export interface LoggerOptions {
  level: string;
  file?: string | undefined;
  pretty?: boolean | undefined;
}

/**
 * Key NAMES only, never values. Even a careless `log.info({ server: cfg })`
 * is safe because this runs before serialisation. Spec §8.
 */
export function redactServerConfig(cfg: unknown): unknown {
  if (cfg === null || typeof cfg !== 'object') return cfg;
  const c = cfg as Record<string, unknown>;
  const env = c['env'];
  const headers = c['headers'];
  return {
    name: c['name'],
    type: c['type'],
    url: c['url'],
    command: c['command'],
    envKeys: env && typeof env === 'object' ? Object.keys(env) : [],
    headerKeys: headers && typeof headers === 'object' ? Object.keys(headers) : [],
  };
}

export function createLogger(opts: LoggerOptions, destination?: DestinationStream): Logger {
  return pino(
    {
      level: opts.level,
      // `null`, not `undefined`: this is pino's documented way to drop pid/hostname,
      // and the only one `exactOptionalPropertyTypes` accepts.
      base: null,
      // No child-logger plumbing anywhere: the mixin reads the ALS on every line.
      mixin() {
        const ctx = currentContext();
        if (!ctx) return {};
        const out: Record<string, string> = { req: ctx.requestId };
        if (ctx.principal !== null) out['usr'] = ctx.principal;
        if (ctx.server !== null) out['srv'] = ctx.server;
        return out;
      },
      serializers: { server: redactServerConfig },
      redact: {
        paths: [
          '*.authorization',
          '*.cookie',
          '*["x-api-key"]',
          '*.accessToken',
          '*.refreshToken',
          '*.clientSecret',
          '*.*.authorization',
          '*.*.cookie',
          '*.*["x-api-key"]',
        ],
        censor: '[redacted]',
      },
    },
    destination ?? fileDestination({ dest: opts.file ?? 1, sync: false }),
  );
}
