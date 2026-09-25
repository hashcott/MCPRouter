import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PlainServerConfig, SLUG_RE, StoredServerConfig } from './server-config.js';

describe('StoredServerConfig', () => {
  it('accepts refs and fills defaults', () => {
    const ref = { $secret: randomUUID() };
    expect(StoredServerConfig.parse({ type: 'stdio', command: 'npx', env: { K: ref } })).toEqual({
      type: 'stdio',
      command: 'npx',
      args: [],
      env: { K: ref },
    });
  });

  it('rejects a plaintext env or header value', () => {
    expect(
      StoredServerConfig.safeParse({ type: 'stdio', command: 'x', env: { K: 'v' } }).success,
    ).toBe(false);
    expect(
      StoredServerConfig.safeParse({ type: 'sse', url: 'https://a.example', headers: { A: 'v' } })
        .success,
    ).toBe(false);
  });

  it('rejects unknown fields and a ref with extra keys', () => {
    expect(StoredServerConfig.safeParse({ type: 'stdio', command: 'x', shell: true }).success).toBe(
      false,
    );
    expect(
      StoredServerConfig.safeParse({
        type: 'stdio',
        command: 'x',
        env: { K: { $secret: randomUUID(), value: 'leak' } },
      }).success,
    ).toBe(false);
  });
});

describe('PlainServerConfig', () => {
  it('accepts plaintext values', () => {
    const r = PlainServerConfig.parse({
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer t' },
    });
    expect(r.type === 'streamable-http' && r.headers).toEqual({ Authorization: 'Bearer t' });
  });

  it.each([
    ['empty value', { type: 'stdio', command: 'x', env: { K: '' } }],
    ['bad env name', { type: 'stdio', command: 'x', env: { 'A-B': 'v' } }],
    ['bad header name', { type: 'sse', url: 'https://a.example', headers: { 'a b': 'v' } }],
    ['non-http url', { type: 'sse', url: 'ftp://a.example' }],
    ['empty command', { type: 'stdio', command: '' }],
    ['openapi (P6)', { type: 'openapi' }],
  ])('rejects %s', (_n, cfg) => {
    expect(PlainServerConfig.safeParse(cfg).success).toBe(false);
  });
});

describe('SLUG_RE', () => {
  it.each(['a', 'fs', 'my-server-2'])('accepts %s', (s) => expect(SLUG_RE.test(s)).toBe(true));
  it.each(['', 'A', 'a__b', 'a_b', '-a', 'a-', 'a'.repeat(65)])('rejects %j', (s) =>
    expect(SLUG_RE.test(s)).toBe(false),
  );
});
