import { describe, expect, it } from 'vitest';
import { pino, type Logger } from 'pino';
import { createDb, createPool, type Db } from '@mcprouter/core';
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

describe('AuditWriter at shutdown', () => {
  // An INSERT that never returns: a hung connection with the database gone quiet.
  const hungDb = (): Db =>
    ({ insert: () => ({ values: () => new Promise(() => {}) }) }) as unknown as Db;
  // An INSERT that fails only after a delay, i.e. after stop() gave up on it.
  const lateFailDb = (ms: number): Db =>
    ({
      insert: () => ({
        values: () => new Promise((_, rej) => setTimeout(() => rej(new Error('late')), ms)),
      }),
    }) as unknown as Db;

  it('stop() spills a batch whose INSERT is still in flight when the budget runs out', async () => {
    const { log, spilled } = capture();
    const w = new AuditWriter({ db: hungDb(), log });
    w.push(row('a'));
    void w.flush();
    await w.stop(50);
    expect(spilled).toEqual([row('a')]);
  });

  it('spillAll() empties the queue and the in-flight batch synchronously (the forced-exit path)', () => {
    const { log, spilled } = capture();
    const w = new AuditWriter({ db: hungDb(), log, batch: 1 });
    w.push(row('a')); // batch of 1 → flush starts, row goes in flight
    w.push(row('b')); // queued behind it
    w.spillAll();
    expect(spilled).toEqual([row('a'), row('b')]);
  });

  it('a batch that fails after stop() is spilled, not re-queued into a writer nobody drains', async () => {
    const { log, spilled } = capture();
    const w = new AuditWriter({ db: lateFailDb(80), log });
    w.push(row('a'));
    void w.flush();
    await w.stop(10); // gives up first, spills the in-flight copy
    await new Promise((r) => setTimeout(r, 120)); // the late failure lands
    expect(spilled).toEqual([row('a')]); // exactly once
  });
});
