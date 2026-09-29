import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  registry: Registry;
  httpRequests: Counter<'route' | 'method' | 'status'>;
  httpDuration: Histogram<'route' | 'method'>;
  integrityBlocks: Counter<'reason'>;
  policyDecisions: Counter<'effect'>;
  policySnapshotAge: Gauge;
}

/**
 * Cardinality rule (spec §8): `route` is a REGISTERED route pattern, never the
 * raw request path, so an unmatched path cannot mint a new series.
 */
export function createRegistry(o: { policyCheckedAt?: () => number | undefined } = {}): Metrics {
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

  // §11.8: without it, "policy started denying everything at 02:00" cannot be alerted on.
  const policyDecisions = new Counter({
    name: 'mcprouter_policy_decision_total',
    help: 'Policy decisions on tool calls, by effect',
    labelNames: ['effect'] as const,
    registers: [registry],
  });

  // Fail STALE on refresh: this says how stale (§11.3).
  const policySnapshotAge = new Gauge({
    name: 'mcprouter_policy_snapshot_age_seconds',
    help: 'Seconds since the policy/routing snapshot was last confirmed against the database',
    registers: [registry],
    collect() {
      const at = o.policyCheckedAt?.();
      // Never confirmed yet reads as infinitely stale, not as fresh.
      this.set(at === undefined ? Number.POSITIVE_INFINITY : (Date.now() - at) / 1000);
    },
  });

  return {
    registry,
    httpRequests,
    httpDuration,
    integrityBlocks,
    policyDecisions,
    policySnapshotAge,
  };
}

export type { Registry };
