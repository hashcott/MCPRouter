import type { ServerCatalog } from './types.js';

export type State =
  | 'disabled'
  | 'idle'
  | 'connecting'
  | 'discovering'
  | 'ready'
  | 'retrying'
  | 'authRequired'
  | 'failed'
  | 'stopping'
  | 'closed';

export type Ev =
  | { t: 'start' }
  | { t: 'connectOk' }
  | { t: 'connectFail'; err: Error; permanent: boolean }
  | { t: 'discoverOk'; catalog: ServerCatalog }
  | { t: 'discoverFail'; err: Error; permanent: boolean }
  | { t: 'authChallenge'; authorizationUrl?: string }
  | { t: 'authResolved' }
  | { t: 'transportClose'; err?: Error }
  | { t: 'backoffElapsed' }
  | { t: 'giveUp' }
  | { t: 'refresh' }
  | { t: 'enable' }
  | { t: 'disable' }
  | { t: 'stop'; intent: 'closed' | 'disabled' | 'idle' }
  | { t: 'stopped' };

/** Resolves to `failed` or `retrying` depending on ev.permanent. */
const FAIL = '@fail' as const;
/** Resolves to the intent captured when `stop` was dispatched. */
const INTENT = '@intent' as const;

export const TABLE: Record<State, Partial<Record<Ev['t'], State | typeof FAIL | typeof INTENT>>> = {
  disabled: { enable: 'idle', stop: 'closed' },
  idle: { start: 'connecting', disable: 'disabled', stop: 'closed' },
  connecting: {
    connectOk: 'discovering',
    connectFail: FAIL,
    transportClose: 'retrying',
    authChallenge: 'authRequired',
    stop: 'stopping',
    disable: 'stopping',
  },
  discovering: {
    discoverOk: 'ready',
    discoverFail: FAIL,
    transportClose: 'retrying',
    authChallenge: 'authRequired',
    stop: 'stopping',
    disable: 'stopping',
  },
  ready: {
    refresh: 'ready',
    transportClose: 'retrying',
    authChallenge: 'authRequired',
    stop: 'stopping',
    disable: 'stopping',
  },
  retrying: { backoffElapsed: 'connecting', giveUp: 'failed', stop: 'closed', disable: 'disabled' },
  authRequired: {
    authResolved: 'connecting',
    start: 'connecting',
    stop: 'closed',
    disable: 'disabled',
  },
  failed: { start: 'connecting', stop: 'closed', disable: 'disabled' },
  // Every other event is dropped while tearing down — including a second `stop`.
  stopping: { stopped: INTENT },
  // TERMINAL: absorbs everything.
  closed: {},
};

/** `undefined` => illegal pair => the caller drops it and debug-logs. Never throws. */
export function next(s: State, ev: Ev, intent: State): State | undefined {
  const to = TABLE[s][ev.t];
  if (to === undefined) return undefined;
  if (to === FAIL) return (ev as { permanent: boolean }).permanent ? 'failed' : 'retrying';
  if (to === INTENT) return intent;
  return to;
}
