import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, redactServerConfig } from './log.js';
import { newRequestId, runWithContext } from './context.js';

function capture(): { sink: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return {
    sink,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('logger', () => {
  it('injects the request id into every line without any call-site plumbing', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info' }, sink);
    const ctx = { requestId: newRequestId(), principal: null, server: null };

    runWithContext(ctx, () => {
      log.info({ evt: 'a' }, 'first');
      log.info({ evt: 'b' }, 'second');
    });

    const out = lines();
    expect(out).toHaveLength(2);
    expect(out[0]?.req).toBe(ctx.requestId);
    expect(out[1]?.req).toBe(ctx.requestId);
  });

  it('omits req when there is no context', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info' }, sink);
    log.info({ evt: 'x' }, 'no context');
    expect(lines()[0]).not.toHaveProperty('req');
  });

  it('redacts a server config down to key NAMES via the serializer', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info' }, sink);

    log.info(
      {
        server: {
          name: 'github',
          type: 'stdio',
          command: 'npx',
          env: { GITHUB_TOKEN: 'ghp_REAL' },
        },
      },
      'connecting',
    );

    const dumped = JSON.stringify(lines()[0]);
    expect(dumped).not.toContain('ghp_REAL');
    expect(dumped).toContain('GITHUB_TOKEN');
    expect(dumped).toContain('github');
  });

  it('redacts authorization-style headers wherever they appear', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info' }, sink);
    log.info({ http: { headers: { authorization: 'Bearer mcpr_REAL' } } }, 'req');
    expect(JSON.stringify(lines()[0])).not.toContain('mcpr_REAL');
  });

  it('redactServerConfig never returns a value from env or headers', () => {
    const out = redactServerConfig({
      name: 'n',
      type: 'streamable-http',
      url: 'https://x.test/mcp',
      env: { A: 'secret-a' },
      headers: { 'x-key': 'secret-b' },
    });
    const dumped = JSON.stringify(out);
    expect(dumped).not.toContain('secret-a');
    expect(dumped).not.toContain('secret-b');
    expect(dumped).toContain('"envKeys":["A"]');
    expect(dumped).toContain('"headerKeys":["x-key"]');
  });
});
