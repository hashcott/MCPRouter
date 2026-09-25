import { describe, expect, it } from 'vitest';
import { Semaphore } from './semaphore.js';
import { UpstreamBusyError } from './errors.js';

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('semaphore', () => {
  it('never runs more than n tasks at once', async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const task = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
    };
    await Promise.all(Array.from({ length: 8 }, () => sem.run(task)));
    expect(peak).toBe(2);
    expect(running).toBe(0);
  });

  it('releases the permit when the task throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(sem.run(async () => 'after')).resolves.toBe('after');
  });

  it('returns the task result', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => 42)).resolves.toBe(42);
  });

  it('runs queued tasks in FIFO order', async () => {
    const sem = new Semaphore(1);
    const gate = defer();
    const order: number[] = [];
    const first = sem.run(async () => {
      await gate.promise;
      order.push(0);
    });
    const rest = [1, 2, 3].map((i) =>
      sem.run(async () => {
        order.push(i);
      }),
    );
    gate.resolve();
    await Promise.all([first, ...rest]);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('rejects with UpstreamBusyError when the acquisition deadline passes', async () => {
    const sem = new Semaphore(1);
    const gate = defer();
    const held = sem.run(async () => {
      await gate.promise;
    });
    await expect(sem.run(async () => 'never', 10)).rejects.toBeInstanceOf(UpstreamBusyError);
    gate.resolve();
    await held;
  });

  it('a timed-out waiter does not consume the permit it never acquired', async () => {
    const sem = new Semaphore(1);
    const gate = defer();
    const held = sem.run(async () => {
      await gate.promise;
    });
    await expect(sem.run(async () => 'x', 10)).rejects.toBeInstanceOf(UpstreamBusyError);
    gate.resolve();
    await held;
    // If the timed-out waiter had kept its place, this would hang.
    await expect(sem.run(async () => 'free')).resolves.toBe('free');
  });
});
