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

/** Expand a valid IPv6 literal to its eight 16-bit groups (dotted tail folded in). */
function hextets(ip: string): number[] {
  let s = ip;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = s.split('::');
  const part = (x: string): number[] => (x === '' ? [] : x.split(':').map((h) => parseInt(h, 16)));
  const h = part(head);
  const t = tail === undefined ? [] : part(tail);
  return [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t];
}

const v4Of = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * The ONLY place a range is listed. Every IPv6 form that embeds an IPv4 address
 * is unwrapped and judged as that IPv4 address — the URL parser rewrites
 * `[::ffff:127.0.0.1]` to `::ffff:7f00:1`, so matching the dotted spelling alone
 * is the classic bypass.
 */
export function isBlockedIp(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (isIPv4(lower)) return v4Blocked(lower);
  if (!isIPv6(lower)) return true; // not an address we understand -> refuse
  const g = hextets(lower);
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const zero4 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
  if (zero4 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) return v4Blocked(v4Of(g6, g7)); // ::/96, ::ffff:0:0/96 (incl. :: and ::1)
  if (zero4 && g4 === 0xffff && g5 === 0) return v4Blocked(v4Of(g6, g7)); // ::ffff:0:0:0/96 (SIIT)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
    return v4Blocked(v4Of(g6, g7)); // NAT64 64:ff9b::/96
  if (g0 === 0x2002) return v4Blocked(v4Of(g1, g2)); // 6to4 2002::/16
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated)
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
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

/** NXDOMAIN is an answer (permanent); any other lookup failure is transient and passes through. */
async function resolveOrRefuse(host: string, deps: GuardDeps): Promise<string[]> {
  try {
    return await (deps.resolve ?? defaultResolve)(host);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOTFOUND') {
      throw new UnsafeUrlError(`Host does not resolve: ${host}`);
    }
    throw err;
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
      const next = new URL(location, target);
      // The same init — Authorization and per-user headers included — goes to
      // every hop, so a hop to another origin would hand it our credentials.
      if (next.origin !== new URL(target).origin) {
        throw new UnsafeUrlError(`Refusing cross-origin redirect to ${next.origin}`);
      }
      target = next.toString();
    }
    throw new UnsafeUrlError(`Too many redirects (max ${MAX_HOPS})`);
  }) as typeof fetch;
}
