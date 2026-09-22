import { describe, expect, it } from 'vitest';
import { TABLE, next, type Ev, type State } from './state.js';

const STATES = Object.keys(TABLE) as State[];

const SAMPLE: Record<Ev['t'], Ev> = {
  start: { t: 'start' },
  connectOk: { t: 'connectOk' },
  connectFail: { t: 'connectFail', err: new Error('x'), permanent: false },
  discoverOk: { t: 'discoverOk', catalog: undefined as never },
  discoverFail: { t: 'discoverFail', err: new Error('x'), permanent: false },
  authChallenge: { t: 'authChallenge' },
  authResolved: { t: 'authResolved' },
  transportClose: { t: 'transportClose' },
  backoffElapsed: { t: 'backoffElapsed' },
  giveUp: { t: 'giveUp' },
  refresh: { t: 'refresh' },
  enable: { t: 'enable' },
  disable: { t: 'disable' },
  stop: { t: 'stop', intent: 'closed' },
  stopped: { t: 'stopped' },
};
const EVENTS = Object.keys(SAMPLE) as Ev['t'][];

describe('state machine', () => {
  it('every legal (state,event) pair produces a state', () => {
    for (const s of STATES) {
      for (const e of Object.keys(TABLE[s]) as Ev['t'][]) {
        const to = next(s, SAMPLE[e], 'closed');
        expect(to, `${s} --${e}-->`).toBeDefined();
        expect(STATES, `${s} --${e}--> ${String(to)}`).toContain(to);
      }
    }
  });

  it('every illegal (state,event) pair is dropped, never thrown', () => {
    for (const s of STATES) {
      const legal = new Set(Object.keys(TABLE[s]));
      for (const e of EVENTS) {
        if (legal.has(e)) continue;
        expect(next(s, SAMPLE[e], 'closed'), `${s} --${e}-->`).toBeUndefined();
      }
    }
  });

  it('closed is terminal and absorbs everything', () => {
    for (const e of EVENTS) {
      expect(next('closed', SAMPLE[e], 'idle')).toBeUndefined();
    }
  });

  it('a permanent failure goes to failed, a transient one to retrying', () => {
    expect(
      next('connecting', { t: 'connectFail', err: new Error('x'), permanent: true }, 'closed'),
    ).toBe('failed');
    expect(
      next('connecting', { t: 'connectFail', err: new Error('x'), permanent: false }, 'closed'),
    ).toBe('retrying');
    expect(
      next('discovering', { t: 'discoverFail', err: new Error('x'), permanent: true }, 'closed'),
    ).toBe('failed');
  });

  it('stopping lands on the intent captured at stop, whatever it was', () => {
    expect(next('stopping', { t: 'stopped' }, 'closed')).toBe('closed');
    expect(next('stopping', { t: 'stopped' }, 'disabled')).toBe('disabled');
    expect(next('stopping', { t: 'stopped' }, 'idle')).toBe('idle');
  });

  it('stopping drops a second stop rather than restarting the teardown', () => {
    expect(next('stopping', { t: 'stop', intent: 'closed' }, 'closed')).toBeUndefined();
  });

  it('a ready server serving a refresh stays ready', () => {
    expect(next('ready', { t: 'refresh' }, 'closed')).toBe('ready');
  });

  it('quiescent states are re-enterable by the documented event only', () => {
    expect(next('disabled', { t: 'enable' }, 'closed')).toBe('idle');
    expect(next('disabled', { t: 'start' }, 'closed')).toBeUndefined();
    expect(next('failed', { t: 'start' }, 'closed')).toBe('connecting');
    expect(next('authRequired', { t: 'authResolved' }, 'closed')).toBe('connecting');
  });
});
