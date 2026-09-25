import type { Logger } from 'pino';
import { schema, type Db } from '@mcprouter/core';
import type { AuditRow } from './app.js';

type Entry = { row: AuditRow; retried: boolean };

/**
 * Audit writes stay OFF the tool-call path (§8): a bounded in-process queue,
 * flushed every `intervalMs` or as soon as `batch` rows wait, by one multi-row
 * INSERT. A failed batch is re-queued once; a second failure — or a full queue —
 * spills each row to the log at `error` (evt 'audit.spill'): it lands in
 * stdout/Docker logs instead of vanishing. SIGKILL/OOM lose the queue; that is
 * the documented trade-off, not a bug.
 */
export class AuditWriter {
  readonly #o: { db: Db; log: Logger; cap: number; batch: number; intervalMs: number };
  #queue: Entry[] = [];
  #timer: NodeJS.Timeout | undefined;
  #flushing: Promise<void> | undefined;

  constructor(o: { db: Db; log: Logger; cap?: number; batch?: number; intervalMs?: number }) {
    this.#o = { cap: 10_000, batch: 200, intervalMs: 250, ...o };
  }

  push(row: AuditRow): void {
    if (this.#queue.length >= this.#o.cap) {
      this.#spill(row);
      return;
    }
    this.#queue.push({ row, retried: false });
    if (this.#queue.length >= this.#o.batch) void this.flush();
  }

  start(): void {
    this.#timer = setInterval(() => void this.flush(), this.#o.intervalMs);
    this.#timer.unref();
  }

  /** Serialized: a flush already running is joined, never run twice at once. */
  flush(): Promise<void> {
    this.#flushing ??= this.#drain().finally(() => {
      this.#flushing = undefined;
    });
    return this.#flushing;
  }

  async stop(budgetMs = 5_000): Promise<void> {
    clearInterval(this.#timer);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.flush().then(() => this.flush()), // the second pass retries a re-queued batch once
      new Promise<void>((r) => {
        timer = setTimeout(r, budgetMs);
      }),
    ]);
    clearTimeout(timer);
    for (const e of this.#queue.splice(0)) this.#spill(e.row);
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, this.#o.batch);
      try {
        await this.#o.db.insert(schema.auditEvent).values(batch.map((e) => e.row));
      } catch (err) {
        this.#o.log.warn(
          {
            evt: 'audit.flush_failed',
            rows: batch.length,
            err: err instanceof Error ? err.message : String(err),
          },
          'audit flush failed',
        );
        for (const e of batch) if (e.retried) this.#spill(e.row);
        this.#queue.unshift(
          ...batch.filter((e) => !e.retried).map((e) => ({ row: e.row, retried: true })),
        );
        return; // the next tick tries again
      }
    }
  }

  #spill(row: AuditRow): void {
    this.#o.log.error({ evt: 'audit.spill', row }, 'audit row not persisted');
  }
}
