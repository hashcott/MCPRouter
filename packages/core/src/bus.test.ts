import { describe, expect, it, vi } from 'vitest';
import { Bus } from './bus.js';

type E = { ping: { n: number }; pong: { s: string } };

describe('bus', () => {
  it('delivers to every listener for a key and to no other key', () => {
    const bus = new Bus<E>();
    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();
    bus.on('ping', a);
    bus.on('ping', b);
    bus.on('pong', other);

    bus.emit('ping', { n: 1 });

    expect(a).toHaveBeenCalledWith({ n: 1 });
    expect(b).toHaveBeenCalledWith({ n: 1 });
    expect(other).not.toHaveBeenCalled();
  });

  it('on() returns an unsubscribe that actually unsubscribes', () => {
    const bus = new Bus<E>();
    const fn = vi.fn();
    const off = bus.on('ping', fn);
    bus.emit('ping', { n: 1 });
    off();
    bus.emit('ping', { n: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing twice is harmless', () => {
    const bus = new Bus<E>();
    const off = bus.on('ping', vi.fn());
    off();
    expect(() => off()).not.toThrow();
  });

  it('one throwing listener does not stop the others', () => {
    const bus = new Bus<E>();
    const after = vi.fn();
    bus.on('ping', () => {
      throw new Error('listener blew up');
    });
    bus.on('ping', after);
    expect(() => bus.emit('ping', { n: 1 })).not.toThrow();
    expect(after).toHaveBeenCalled();
  });

  it('emitting a key nobody listens to is a no-op', () => {
    const bus = new Bus<E>();
    expect(() => bus.emit('pong', { s: 'x' })).not.toThrow();
  });
});
