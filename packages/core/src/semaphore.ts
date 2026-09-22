import { UpstreamBusyError } from './errors.js';

type Waiter = { grant: () => void; reject: (e: Error) => void; done: boolean };

/**
 * FIFO counting semaphore. `run` holds a permit for the lifetime of `fn` and
 * releases it in `finally`, so a rejecting task cannot leak one.
 *
 * `deadlineMs` bounds the WAIT, not the task: a caller that cannot get a permit
 * in time gets UpstreamBusyError instead of queueing behind a slow upstream
 * forever.
 */
export class Semaphore {
  #free: number;
  readonly #queue: Waiter[] = [];

  constructor(n: number) {
    this.#free = n;
  }

  async run<T>(fn: () => Promise<T>, deadlineMs?: number): Promise<T> {
    await this.#acquire(deadlineMs);
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  async #acquire(deadlineMs?: number): Promise<void> {
    if (this.#free > 0) {
      this.#free -= 1;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        done: false,
        grant: () => {
          waiter.done = true;
          resolve();
        },
        reject: (e) => {
          waiter.done = true;
          reject(e);
        },
      };
      this.#queue.push(waiter);
      if (deadlineMs !== undefined) {
        const timer = setTimeout(() => {
          if (waiter.done) return;
          const i = this.#queue.indexOf(waiter);
          if (i >= 0) this.#queue.splice(i, 1);
          waiter.reject(new UpstreamBusyError('semaphore'));
        }, deadlineMs);
        timer.unref?.();
      }
    });
  }

  #release(): void {
    // Skip anyone who already timed out; their slot was spliced but be defensive.
    let waiter = this.#queue.shift();
    while (waiter !== undefined && waiter.done) waiter = this.#queue.shift();
    if (waiter !== undefined) {
      waiter.grant();
      return;
    }
    this.#free += 1;
  }
}
