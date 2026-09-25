import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  registry: Registry;
  httpRequests: Counter<'route' | 'method' | 'status'>;
  httpDuration: Histogram<'route' | 'method'>;
  integrityBlocks: Counter<'reason'>;
}

/**
 * Cardinality rule (spec §8): `route` is a REGISTERED route pattern, never the
 * raw request path, so an unmatched path cannot mint a new series.
 */
export function createRegistry(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: '' });

  const httpRequests = new Counter({
    name: 'mcprouter_http_requests_total',
    help: 'HTTP requests by matched route, method and status class',
    labelNames: ['route', 'method', 'status'] as const,
    registers: [registry],
  });

  const httpDuration = new Histogram({
    name: 'mcprouter_http_request_duration_seconds',
    help: 'HTTP request duration by matched route and method',
    labelNames: ['route', 'method'] as const,
    buckets: [0.005, 0.025, 0.1, 0.5, 1, 5],
    registers: [registry],
  });

  const integrityBlocks = new Counter({
    name: 'mcprouter_integrity_block_total',
    help: 'Calls refused because an item is unreviewed, rejected, changed or defective',
    labelNames: ['reason'] as const,
    registers: [registry],
  });

  return { registry, httpRequests, httpDuration, integrityBlocks };
}

export type { Registry };
