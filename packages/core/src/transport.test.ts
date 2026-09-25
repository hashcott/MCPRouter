import { describe, expect, it } from 'vitest';
import { assertPlainStringMap, augmentPath, createTransport } from './transport.js';
import { UnsafeUrlError } from './errors.js';
import type { ServerConfig } from './types.js';

const base = { enabled: true, credentialMode: 'shared' as const };

describe('assertPlainStringMap (Ruling P3)', () => {
  it('passes a plain string map through unchanged', () => {
    expect(assertPlainStringMap('env', { A: '1', B: 'two' })).toEqual({ A: '1', B: 'two' });
  });

  it('treats undefined as empty', () => {
    expect(assertPlainStringMap('env', undefined)).toEqual({});
  });

  it('refuses an unresolved secret reference rather than stringifying it', () => {
    expect(() =>
      assertPlainStringMap('env', { TOKEN: { $secret: 'abc' } as unknown as string }),
    ).toThrow(/TOKEN/);
  });

  it('names the offending key so the operator can find it', () => {
    const err = (() => {
      try {
        assertPlainStringMap('headers', { authorization: { $secret: 'x' } as unknown as string });
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toContain('headers');
    expect(err?.message).toContain('authorization');
  });

  it('does NOT expand a variable reference — the value passes through verbatim (Ruling P2)', () => {
    process.env['MCPR_TEST_LEAK'] = 'leaked-value';
    try {
      expect(assertPlainStringMap('env', { A: '${MCPR_TEST_LEAK}' })).toEqual({
        A: '${MCPR_TEST_LEAK}',
      });
    } finally {
      delete process.env['MCPR_TEST_LEAK'];
    }
  });
});

describe('augmentPath', () => {
  it('keeps the existing PATH and appends the common tool locations', () => {
    const out = augmentPath({ PATH: '/usr/bin' });
    expect(out['PATH']).toContain('/usr/bin');
    expect(out['PATH']).toContain('/usr/local/bin');
  });

  it('does not duplicate an entry already present', () => {
    const out = augmentPath({ PATH: '/usr/local/bin' });
    const hits = out['PATH']?.split(':').filter((p) => p === '/usr/local/bin').length;
    expect(hits).toBe(1);
  });
});

describe('createTransport', () => {
  const ctx = {
    headers: {},
    signal: new AbortController().signal,
    onStderr: () => {},
  };

  it('refuses an http upstream whose URL is private', async () => {
    const cfg: ServerConfig = {
      ...base,
      name: 'x',
      type: 'streamable-http',
      url: 'http://127.0.0.1:9/mcp',
    };
    await expect(createTransport(cfg, ctx)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses an sse upstream whose URL is private', async () => {
    const cfg: ServerConfig = { ...base, name: 'x', type: 'sse', url: 'http://10.0.0.1/mcp' };
    await expect(createTransport(cfg, ctx)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses a stdio upstream carrying an unresolved secret in env', async () => {
    const cfg = {
      ...base,
      name: 'x',
      type: 'stdio' as const,
      command: 'node',
      env: { TOKEN: { $secret: 'abc' } as unknown as string },
    };
    await expect(createTransport(cfg, ctx)).rejects.toThrow(/TOKEN/);
  });
});
