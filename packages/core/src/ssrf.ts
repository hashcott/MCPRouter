import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import { UnsafeUrlError } from './errors.js';

const MAX_HOPS = 5;

/** Injection points exist so the unit test never touches the network. */
export type GuardDeps = {
  fetchImpl?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
};

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

function v4Blocked(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return true;
  const [a = 0, b = 0] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT RFC6598
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * The ONLY place a range is listed. IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is
 * unwrapped first — treating it as "some IPv6 address" is the classic bypass.
 */
export function isBlockedIp(ip: string): boolean {
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1] !== undefined) return v4Blocked(mapped[1]);
  if (isIPv4(lower)) return v4Blocked(lower);
  if (!isIPv6(lower)) return true; // not an address we understand -> refuse
  if (lower === '::' || lower === '::1') return true; // unspecified + loopback
  if (lower.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(lower)) return true; // unique local fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}

/**
 * Rejects a URL whose scheme is not http(s), or any of whose resolved addresses
 * is private/loopback/link-local/CGNAT. The error never contains the resolved
 * address: an SSRF probe must not be able to use our error text as a DNS oracle.
 */
export async function assertSafeUrl(
  url: string,
  allowPrivate?: boolean,
  deps: GuardDeps = {},
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrlError(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError(`Unsupported scheme: ${parsed.protocol.replace(':', '')}`);
  }
  if (allowPrivate === true) return;

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIPv4(host) || isIPv6(host) ? [host] : await resolveOrRefuse(host, deps);
  if (addresses.length === 0) throw new UnsafeUrlError(`Host does not resolve: ${parsed.hostname}`);
  if (addresses.some((ip) => isBlockedIp(ip))) {
    throw new UnsafeUrlError(`Host resolves to a non-public address: ${parsed.hostname}`);
  }
}

async function resolveOrRefuse(host: string, deps: GuardDeps): Promise<string[]> {
  try {
    return await (deps.resolve ?? defaultResolve)(host);
  } catch {
    throw new UnsafeUrlError(`Host does not resolve: ${host}`);
  }
}

/**
 * A `fetch` that refuses to follow a redirect it has not validated. `redirect:'manual'`
 * is load-bearing: with the default `'follow'` the platform chases the Location header
 * itself and our per-hop check never runs.
 */
export function guardedFetch(allowPrivate?: boolean, deps: GuardDeps = {}): typeof fetch {
  const impl = deps.fetchImpl ?? fetch;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    let target = typeof input === 'string' || input instanceof URL ? String(input) : input.url;

    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      await assertSafeUrl(target, allowPrivate, deps);
      const res = await impl(target, { ...init, redirect: 'manual' });
      if (res.status < 300 || res.status > 399) return res;

      const location = res.headers.get('location');
      if (location === null) return res;
      target = new URL(location, target).toString();
    }
    throw new UnsafeUrlError(`Too many redirects (max ${MAX_HOPS})`);
  }) as typeof fetch;
}
