import { describe, expect, it } from 'vitest';
import { assertSafeUrl, guardedFetch, isBlockedIp } from './ssrf.js';
import { UnsafeUrlError } from './errors.js';

describe('isBlockedIp', () => {
  const blocked = [
    '127.0.0.1',
    '127.9.9.9',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    // The forms the URL parser produces, and the other ways to embed IPv4.
    '::',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::FFFF:7F00:1',
    '::127.0.0.1',
    '::7f00:1',
    '::ffff:0:7f00:1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
    'fe90::1',
    'febf::1',
    'fec0::1',
    'fd12:3456::1',
    'ff02::1',
  ];
  const allowed = [
    '1.1.1.1',
    '8.8.8.8',
    '172.32.0.1',
    '100.63.255.255',
    '2606:4700::1111',
    '::ffff:808:808',
    '64:ff9b::808:808',
    '2002:101:101::1',
  ];

  it.each(blocked)('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(allowed)('allows %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  it('rejects a non-http scheme before any DNS lookup', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeUrl('gopher://x/')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects a literal loopback host', async () => {
    await expect(assertSafeUrl('http://127.0.0.1:8080/mcp')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects a hostname that resolves to loopback', async () => {
    await expect(assertSafeUrl('http://localhost:8080/mcp')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('allows a loopback host when the server opted in explicitly', async () => {
    await expect(assertSafeUrl('http://127.0.0.1:8080/mcp', true)).resolves.toBeUndefined();
  });

  it.each([
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::127.0.0.1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[::ffff:0:7f00:1]/',
    'http://[fe90::1]/',
  ])('rejects the bracketed literal %s after the URL parser rewrites it', async (url) => {
    await expect(assertSafeUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('treats NXDOMAIN as unsafe (permanent)', async () => {
    const resolve = async (): Promise<string[]> => {
      throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    };
    await expect(assertSafeUrl('https://nx.test/', false, { resolve })).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it('passes a transient DNS failure through untouched so the caller retries', async () => {
    const resolve = async (): Promise<string[]> => {
      throw Object.assign(new Error('try again'), { code: 'EAI_AGAIN' });
    };
    const err = await assertSafeUrl('https://slow.test/', false, { resolve }).catch(
      (e: Error) => e,
    );
    expect(err).not.toBeInstanceOf(UnsafeUrlError);
    expect((err as { code?: string }).code).toBe('EAI_AGAIN');
  });

  it('never leaks the resolved address into the error message', async () => {
    const err = await assertSafeUrl('http://localhost/mcp').catch((e: Error) => e);
    expect(err.message).toContain('localhost');
    expect(err.message).not.toMatch(/\b127\.0\.0\.1\b/);
  });
});

describe('guardedFetch', () => {
  it('follows a safe redirect and returns the final response', async () => {
    const seen: string[] = [];
    const inner = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith('/a')) {
        return new Response(null, { status: 302, headers: { location: 'https://example.test/b' } });
      }
      return new Response('done', { status: 200 });
    };
    const f = guardedFetch(true, {
      fetchImpl: inner as typeof fetch,
      resolve: async () => ['93.184.216.34'],
    });
    const res = await f('https://example.test/a');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('done');
    expect(seen).toEqual(['https://example.test/a', 'https://example.test/b']);
  });

  it('rejects a redirect that points at a private address', async () => {
    const inner = async (): Promise<Response> =>
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } });
    const f = guardedFetch(false, {
      fetchImpl: inner as typeof fetch,
      resolve: async () => ['93.184.216.34'],
    });
    await expect(f('https://example.test/a')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses a cross-origin redirect so credential headers never reach another host', async () => {
    const seen: string[] = [];
    const inner = async (input: string | URL | Request): Promise<Response> => {
      seen.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'https://evil.test/x' } });
    };
    const f = guardedFetch(false, {
      fetchImpl: inner as typeof fetch,
      resolve: async () => ['93.184.216.34'],
    });
    await expect(
      f('https://example.test/a', { headers: { authorization: 'Bearer t' } }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(seen).toEqual(['https://example.test/a']);
  });

  it('stops after 5 hops instead of following a redirect loop', async () => {
    let n = 0;
    const inner = async (): Promise<Response> => {
      n += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://example.test/${n}` },
      });
    };
    const f = guardedFetch(false, {
      fetchImpl: inner as typeof fetch,
      resolve: async () => ['93.184.216.34'],
    });
    await expect(f('https://example.test/0')).rejects.toThrow(/redirect/i);
    expect(n).toBeLessThanOrEqual(6);
  });

  it('passes redirect:manual to the underlying fetch so it cannot follow on its own', async () => {
    let got: RequestInit | undefined;
    const inner = async (_i: unknown, init?: RequestInit): Promise<Response> => {
      got = init;
      return new Response('ok', { status: 200 });
    };
    const f = guardedFetch(false, {
      fetchImpl: inner as typeof fetch,
      resolve: async () => ['93.184.216.34'],
    });
    await f('https://example.test/a');
    expect(got?.redirect).toBe('manual');
  });
});
