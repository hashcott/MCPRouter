import { describe, expect, it } from 'vitest';
import { pino, type Logger } from 'pino';
import { createDb, createPool } from '@mcprouter/core';
import type { AuditRow } from './app.js';
import { AuditWriter } from './audit.js';

const row = (item: string): AuditRow => ({
  evt: 'tool.call',
  requestId: null,
  principalId: 'u1',
  keyId: 'k1',
  route: 'all',
  server: 'fs',
  item,
  outcome: 'ok',
  durationMs: 1,
  inputKeys: [],
  inputBytes: 2,
  error: null,
});

function capture(): { log: Logger; spilled: unknown[] } {
  const spilled: unknown[] = [];
  const log = pino({ level: 'silent' });
  log.error = ((o: { evt?: string; row?: unknown }) => {
    if (o.evt === 'audit.spill') spilled.push(o.row);
  }) as Logger['error'];
  return { log, spilled };
}

const deadDb = () => createDb(createPool('postgres://u:p@127.0.0.1:1/none'));

describe('AuditWriter without a database', () => {
  it('re-queues a failed batch once, then spills each row to the log', async () => {
    const { log, spilled } = capture();
    const w = new AuditWriter({ db: deadDb(), log });
    w.push(row('a'));
    w.push(row('b'));
    await w.flush(); // fails, re-queued
    expect(spilled).toEqual([]);
    await w.flush(); // fails again, spilled
    expect(spilled).toEqual([row('a'), row('b')]);
  });

  it('spills immediately when the queue is full, and never throws at the caller', () => {
    const { log, spilled } = capture();
    const w = new AuditWriter({ db: deadDb(), log, cap: 2, batch: 100 });
    w.push(row('a'));
    w.push(row('b'));
    expect(() => w.push(row('c'))).not.toThrow();
    expect(spilled).toEqual([row('c')]);
  });

  it('stop() spills whatever it could not persist within the budget', async () => {
    const { log, spilled } = capture();
    const w = new AuditWriter({ db: deadDb(), log });
    w.push(row('a'));
    await w.stop(2_000);
    expect(spilled).toEqual([row('a')]);
  });
});
