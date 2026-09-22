import type { State } from './state.js';

type Handler<T> = (payload: T) => void;

/**
 * Typed facade over a Map of listener sets. One bus per Engine.
 *
 * `emit` isolates listeners: a throwing subscriber must not abort delivery to the
 * others, and must never propagate into the engine's own state machine, which is
 * frequently what emits.
 */
export class Bus<E extends Record<string, unknown>> {
  readonly #listeners = new Map<keyof E, Set<Handler<never>>>();
  readonly #onError: (err: unknown) => void;

  constructor(onError: (err: unknown) => void = () => {}) {
    this.#onError = onError;
  }

  on<K extends keyof E>(key: K, fn: Handler<E[K]>): () => void {
    let set = this.#listeners.get(key);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(key, set);
    }
    const target = set;
    target.add(fn as Handler<never>);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      target.delete(fn as Handler<never>);
    };
  }

  emit<K extends keyof E>(key: K, payload: E[K]): void {
    const set = this.#listeners.get(key);
    if (set === undefined) return;
    for (const fn of [...set]) {
      try {
        (fn as Handler<E[K]>)(payload);
      } catch (err) {
        this.#onError(err);
      }
    }
  }
}

export type EngineEvents = {
  'server:state': {
    name: string;
    key: string;
    from: State;
    to: State;
    attempt: number;
    error?: { code: string; message: string };
    authorizationUrl?: string;
  };
  'server:catalog': {
    name: string;
    changed: boolean;
    tools: number;
    prompts: number;
    resources: number;
    fetchedAt: number;
  };
  'call:start': {
    callId: string;
    server: string;
    kind: 'tool' | 'prompt' | 'resource';
    target: string;
    principalId: string;
    scopeKey: string;
    /** BY REFERENCE. A listener must not retain or mutate this. */
    args: unknown;
  };
  'call:end': {
    callId: string;
    ok: boolean;
    isError: boolean;
    durationMs: number;
    errorCode?: string;
    result?: unknown;
  };
  'upstream:log': { name: string; stream: 'stderr' | 'mcp'; level: string; message: string };
  'config:applied': {
    generation: number;
    added: string[];
    changed: string[];
    removed: string[];
  };
};
