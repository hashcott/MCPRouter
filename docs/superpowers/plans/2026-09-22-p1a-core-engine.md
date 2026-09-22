# MCPRouter P1a — Core MCP Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `packages/core` exports an `Engine` that holds live upstream MCP connections over stdio / streamable-http / sse, projects one namespaced tool catalog out of them, and executes calls through a single predicate — with no HTTP, no sessions, no authz and no config storage anywhere inside it.

**Architecture:** Scope is a **parameter, never state**: every public method is `(ResolvedScope, Principal, …) => result`, so there is no session→group map to re-inject before a check. **One predicate answers both "is it listed" and "is it callable"** (`isExposed`), which makes the mcphub CVE class (two independent gates that can disagree) structurally impossible rather than merely fixed. The **`TransportFactory` is injectable**, which is simultaneously the test seam (a real `McpServer` over `InMemoryTransport` — no child processes, no ports) and the door for OpenAPI-as-MCP in P6.

**Tech Stack:** `@modelcontextprotocol/sdk@1.30.0` — the only runtime dependency core gains in this plan · Node 22 stdlib (`node:dns/promises`, `node:net`, `node:child_process`, `node:async_hooks`) · vitest 5.0.1 · everything else inherited from P0.

**Spec:** `docs/superpowers/specs/2026-09-19-mcprouter-design.md` — read §2 (protocol reality), §4.1 (engine), §5.4 (secret at rest), §11.4 (the seam), §13 P1.
**Design:** `docs/superpowers/designs/engine.json` — the decisions (D1–D16) and interface sketches this plan implements. Where this plan and the design disagree, the **Rulings** below say which wins and why.

**Scope of this plan:** P1 was split into three plans, each shipping working, testable software. This is the first.

| plan | delivers | testable by |
| ---- | -------- | ----------- |
| **P1a (this one)** | `packages/core` Engine: registry, transports, SSRF, catalog, call | in-process fake upstream + one real child process |
| P1b | `servers` + `secrets` tables, AES-256-GCM `seal`/`open`, `{"$secret":uuid}` resolution, `MCPR_SECRET_KEYS` boot check | testcontainers |
| P1c | better-auth + apiKey, `POST /mcp` + 405, `mcprouter servers add` | the §13 day-21 demo, end to end |

---

## Global Constraints

Inherited from P0 and still binding. Every task's requirements implicitly include this section.

- **Package manager is pnpm 10.12.4.** Never `npm install`.
- **ESM only.** `"type": "module"`, `nodenext`, `verbatimModuleSyntax: true`. **Every relative import ends in `.js`**, even from a `.ts` source.
- **`packages/core` must never depend on `hono` or `better-auth`** — not in `dependencies`, not in `devDependencies`.
- **The string `'session'` must not appear in `packages/core`.** Scope is a parameter; there is nothing to call a session.
- **CI gates stay at their final numbers.** Coverage: global lines 70 / functions 70 / branches 60. `packages/core/src/security/**` and `packages/core/src/tools/**`: lines 90 / branches 85. Those two globs are already configured and still match nothing; this plan does not create them.
- **`retry: 0`.** A flaky test is deleted, not retried.
- Commit after every task. Conventional Commits. **No `Co-Authored-By` trailer** (user rule, `~/.claude/CLAUDE.md`). Do not push.
- **`tsc -b`, `oxlint`, `prettier --check` and `vitest` must all exit 0 before a task is committed.** `pnpm lint` currently exits 0 with **zero warnings** — keep it that way.

New constraints introduced by this plan:

- **`SEP = '__'` is a constant, never configuration** (D6). A server name containing `__` is rejected at the schema boundary, which is what makes the `startsWith(label + SEP)` scan unambiguous even with aliases.
- **Core performs no authorization.** It receives an already-authorized `ResolvedScope`. An empty `servers` array means an empty catalog — *never* "all".
- **Core never decrypts anything.** It calls `principal.credentials.resolveHeaders(name)`. Decryption belongs to P1b.
- **One construction site per error message.** `ToolUnavailableError`'s text is built in exactly one place so that hidden, missing and disabled are byte-identical to a caller.
- **Every error leaving core passes through `redact()`** with the list of credential values resolved for that call.

---

## Preflight Conflict Scan

### Verified before writing this plan

| Claim | How it was checked | Result |
| ----- | ------------------ | ------ |
| `@modelcontextprotocol/sdk@1.30.0` exists and is fetchable | `npm view … dist.tarball` | current release, tarball 200 |
| The SDK import paths the design uses are real | installed 1.30.0, `await import()` on all 8 symbols | `client/index.js`, `client/stdio.js` (`StdioClientTransport`, `getDefaultEnvironment`), `client/streamableHttp.js`, `client/sse.js`, `server/mcp.js`, `inMemory.js`, `server/streamableHttp.js` — **all resolve** |
| The SDK depends on `hono`, `@hono/node-server` and `express` | read its `dependencies` | true — see Ruling P1 |
| Adding the SDK to `core` does **not** make `hono` reachable from `core` | built a throwaway pnpm workspace with `node-linker=isolated`, added the SDK to a core-like package, `require.resolve` from that package | SDK **reachable**; `hono` **MODULE_NOT_FOUND**; `express` **MODULE_NOT_FOUND** |

### Rulings

**Ruling P1 — the SDK pulls `hono` in transitively, and that is fine, but it must be re-proven.**
`@modelcontextprotocol/sdk` depends on `hono ^4.11.4` and `express ^5.2.1` (it ships server-side helpers this project does not use). Under pnpm's isolated linker a transitive dependency is never on its dependent's resolution path, so `packages/core` still cannot resolve `hono` — verified above in a scratch workspace. **Because this is the project's single most load-bearing architectural rule, Task 1 re-runs the P0 `forbidden.ts` proof against the real repo after the SDK is installed.** Cost if wrong: the "swap the MCP era later" property quietly dies and nothing tells us until a reviewer notices an import. Cost of the check: two commands.

**Ruling P2 — spec §5.4 beats engine D13 on `${VAR}` expansion. Drop the expansion entirely.**
D13 says "we keep the expansion" of `${VAR}` / `$VAR` from `process.env` in env values and argv, and only makes the unresolved case loud. Spec §5.4 says the opposite, in bold, and names the mechanism as the reason secrets end up in config files: *"Không có expansion `${VAR}`/`$VAR` từ `process.env`"*. The spec is the authority, and it wins on the merits too: MCPRouter's secret path is `{"$secret":"<uuid>"}` resolved against the `secrets` table (P1b), and §5.4 states plaintext secret values are **not representable** in any other column. Re-adding a `process.env` reader would reintroduce exactly the representable-plaintext path the schema design exists to remove.
**So:** `createTransport` passes `cfg.env` values through **verbatim**. No expansion, no `expandAll`, no `expandEnv`. D13's fail-closed half is preserved where it still applies — see Ruling P3. Cost if wrong: a config that wants `${HOME}` in a path must write the literal path. Upgrade path: if a real need appears, it resolves from the server's own resolved config, never from `process.env`, and gets its own ruling.

**Ruling P3 — `{"$secret":…}` is not resolvable in P1a, so it must fail closed, not pass through.**
P1b owns secret resolution, but P1a is what spawns processes and sets headers. If a config value is the object `{"$secret":"<uuid>"}` and P1a stringifies it, the upstream receives the literal text `[object Object]` and the server connects **unauthenticated** — D13's named "connected but unauthenticated silent degradation", arriving through the back door. Task 5 therefore rejects any non-string env/header value with a named error that fails the server into `failed`. P1b replaces the rejection with resolution. Cost if wrong: nothing in P1a, since no caller can produce a `$secret` yet; the guard is what keeps that true.

**Ruling P4 — `stopping` drops every event except `stopped`, and that includes `stop`.**
The design's table gives `stopping: { stopped: INTENT }` and the note says "every other event is dropped". A second `stop()` while already stopping is therefore a no-op that never resolves a second promise. `UpstreamServer.stop()` must return the *same* in-flight promise on re-entry rather than dispatching again. Cost if wrong: `shutdown()` hangs forever on a double-stop, which is exactly the kind of bug that only shows up in CI teardown.

**Ruling P5 — `catalogVersion` must increment on catalog emit, not only on `applyConfig`.**
The registry sketch says `catalogVersion` is `++ per applyConfig OR any server:catalog emit`, and `projectTools` memoizes on `${scope.key}:${reg.catalogVersion}`. If a `listChanged` refresh swapped a catalog without bumping the counter, every scope would serve a stale tool list from the memo until the next config write. Task 8 wires the registry to the bus for this, and Task 9's test asserts memo invalidation on refresh specifically.

**Ruling P6 — the SDK is not `exactOptionalPropertyTypes`-clean, so `createTransport` converts at one boundary.**
Found while executing Task 5. The SDK's `Transport` interface declares one optional `string`
property, while its own concrete transports expose that property as a getter typed
`string | undefined`. Under `exactOptionalPropertyTypes` those are not assignable, so
`new StreamableHTTPClientTransport(...)` cannot be returned as a `Transport` — TS2322, even
though the object is structurally correct in every way this codebase uses it. The SDK is not
compiled with the flag, so upstream never saw it.
**So:** `transport.ts` has one private `asTransport()` helper with the reason written above it,
and all three branches return through it. The alternative — dropping
`exactOptionalPropertyTypes` repo-wide — would trade a real correctness flag across four
packages for one upstream declaration mismatch. Cost if wrong: nothing structural; the day the
SDK fixes its declaration the helper becomes a no-op and can be deleted.
**Note for the implementer:** the explanation above deliberately does not name the property,
because the global constraint forbids that string appearing anywhere in `packages/core` and
Task 11 Step 6 greps for it.

**Ruling P7 — the fake upstream must use the SDK's low-level `Server`, not `McpServer.registerTool`.**
Found while executing Task 6; both halves were caught by the fake's own test, which exists for
exactly this reason.
(a) `registerTool`'s `inputSchema` is zod-typed (`ZodRawShapeCompat | AnySchema`, and
`AnySchema = z3.ZodTypeAny | z4.$ZodType`). zod is a transitive dependency of the SDK and is
therefore **not reachable from `packages/core`** — `require.resolve` returns MODULE_NOT_FOUND,
which is the isolation working. Passing `inputSchema: {}` typechecks and then silently discards
every argument: handlers saw `{}` and the test read `wrote undefined`. Adding zod to core just
to describe a fake's arguments is the wrong trade.
(b) One `Protocol` instance cannot be reconnected — the second `connect()` throws "Already
connected to a transport". A fake that reuses one server would have surfaced as a phantom
reconnect bug in Tasks 7 and 8.
**So:** the fake builds a fresh `Server` per `connect()` and registers `ListToolsRequestSchema` /
`CallToolRequestSchema` handlers, reading `request.params.arguments` verbatim. No new
dependency, and an argument crossing the wire becomes observable. The code block in Task 6 is
the corrected version.

**Ruling P8 — the design's state table drops the result of a refresh, and the catalog goes stale forever.**
Found by Task 8's Ruling P5 test, which is the reason that test exists. The table makes
`discoverOk` legal only from `discovering`, while `refresh` is `ready -> ready`. So a
`listChanged` on a live connection re-lists the upstream and then hands `discoverOk` to a server
in `ready`, where it is an illegal pair and is **dropped**. The catalog is never swapped, no
`server:catalog` is emitted, `catalogVersion` never moves, and `projectTools`' memo keeps
serving the old tool list indefinitely. The symptom is silent and permanent.
**So:** `ready` gains `discoverOk: 'ready'`. Every catalog swap still flows through the single
`dispatch` path, which is the invariant the design actually wanted. `discoverFail` is left
illegal from `ready` deliberately — one failed re-list should keep the last good catalog rather
than tear down a healthy server, and a genuinely dead connection arrives as `transportClose`,
which does go to `retrying`. Cost if wrong: a failed refresh is dropped and debug-logged instead
of escalating; the next transport-level failure still escalates normally.

### Per-task self-consistency

| Task | Finding |
| ---- | ------- |
| T1 | clean — types and errors are copied from the design sketches verbatim |
| T2 | clean — the table is pure data; the test is generated from the table itself |
| T3 | clean |
| T4 | ⚠ DNS rebinding is **not** closed by `assertSafeUrl` alone — see the note in Task 4 Step 4 |
| T5 | ⚠ carries Rulings P2 and P3 |
| T6 | clean |
| T7 | ⚠ carries Ruling P4 |
| T8 | ⚠ carries Ruling P5 |
| T9 | clean — `isExposed` is shared by list and call by construction, and the test asserts it |
| T10 | ⚠ D11's retry gate is the whole point of the task; the test names the double-execute case |
| T11 | clean |
| T12 | clean — the only task that spawns a real process |

---

### Task 1: Dependencies, types, errors, and the event bus

**Files:**

- Modify: `packages/core/package.json` (add the SDK)
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/errors.ts`
- Create: `packages/core/src/bus.ts`
- Test: `packages/core/src/bus.test.ts`, `packages/core/src/errors.test.ts`

**Interfaces:**

- Consumes: the P0 workspace. `packages/core` currently exports `VERSION`, the obs helpers and the db helpers.
- Produces:
  - `ServerConfig`, `ServerSelection`, `ResolvedScope`, `Principal`, `CredentialResolver`, `ServerCatalog`, `ServerStatus`, `CallOpts`, `SEP`
  - `ToolUnavailableError`, `UpstreamUnavailableError`, `UpstreamAuthRequiredError`, `CredentialsRequiredError`, `UpstreamBusyError`, `PayloadTooLargeError`, `UnsafeUrlError`, `redact()`
  - `Bus<E>` with `on(k, fn): () => void` and `emit(k, payload): void`

- [ ] **Step 1: Add the SDK**

```bash
pnpm --filter @mcprouter/core add @modelcontextprotocol/sdk@1.30.0
```

- [ ] **Step 2: Re-prove the dependency direction (Ruling P1)**

The SDK depends on `hono`. Prove that this did not leak into `core`'s resolution path. Create `packages/core/src/forbidden.ts`:

```ts
// TEMPORARY — this file must FAIL to build. Delete it in the next step.
import { Hono } from 'hono';
export const x = Hono;
```

Run:

```bash
pnpm build
node -e "try{require.resolve('hono/package.json',{paths:['packages/core']});console.log('REACHABLE — STOP')}catch(e){console.log('hono: '+e.code)}"
```

Expected: `tsc` reports `packages/core/src/forbidden.ts(2,22): error TS2307: Cannot find module 'hono'`, and the node line prints `hono: MODULE_NOT_FOUND`.
If `hono` IS reachable, **stop and escalate** — the architecture rule is broken and the fix is not in this task.

Then:

```bash
rm packages/core/src/forbidden.ts
pnpm build   # green again
```

- [ ] **Step 3: Write the types**

`packages/core/src/types.ts`:

```ts
import type {
  Prompt,
  Resource,
  ResourceTemplate,
  ServerCapabilities,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

export type { Prompt, Resource, ResourceTemplate, ServerCapabilities, Tool };

/** Not configurable. A server name containing this is rejected at the schema boundary (D6). */
export const SEP = '__';

export type ServerSelection = {
  serverName: string;
  /** Renames the server on this route only. */
  alias?: string;
  /** BARE upstream names, never prefixed. */
  tools: 'all' | string[];
  prompts: 'all' | string[];
  resources: 'all' | string[];
};

export type ResolvedScope = {
  /** Stable memo key. MUST be a pure function of the fields below. packages/server computes it. */
  key: string;
  /** Already authorized. Core does NO authz. An empty array means an empty catalog, never 'all'. */
  servers: ServerSelection[];
  /** Single-server route: strip the `<server>__` prefix. Set only when servers.length === 1. */
  flatten: boolean;
};

export interface CredentialResolver {
  /** Returns {} when this principal has no binding for this server. Never throws for 'missing'. */
  resolveHeaders(serverName: string): Promise<Record<string, string>>;
  /** Opaque; changes when the underlying binding changes. Used as the connection key suffix. */
  revision(serverName: string): string;
}

export type Principal = {
  /** User id, or the api-key owner's user id. */
  id: string;
  isAdmin: boolean;
  /** Present ONLY when this auth path is permitted to use per-user secrets. */
  credentials?: CredentialResolver | undefined;
};

export type ServerConfigBase = {
  name: string;
  enabled: boolean;
  credentialMode: 'shared' | 'per-user';
  /** Keys are BARE upstream tool names. Core rejects any key containing SEP. */
  tools?: Record<string, { enabled?: boolean; description?: string }> | undefined;
  timeouts?: { connectMs?: number; requestMs?: number } | undefined;
  maxConcurrentCalls?: number | undefined;
};

export type ServerConfig = ServerConfigBase &
  (
    | {
        type: 'stdio';
        command: string;
        args?: string[] | undefined;
        env?: Record<string, string> | undefined;
        cwd?: string | undefined;
      }
    | {
        type: 'streamable-http' | 'sse';
        url: string;
        headers?: Record<string, string> | undefined;
        /** Explicit, audited SSRF escape hatch. There is NO owner-based bypass (D12). */
        allowPrivateNetwork?: boolean | undefined;
      }
  );

export type ServerCatalog = {
  /** Keyed by BARE name. Descriptions are already overridden at cache time. */
  tools: ReadonlyMap<string, Tool>;
  prompts: ReadonlyMap<string, Prompt>;
  resources: readonly Resource[];
  resourceTemplates: readonly ResourceTemplate[];
  capabilities: ServerCapabilities;
  instructions?: string | undefined;
  fetchedAt: number;
  /** Drives the server:catalog{changed} flag. */
  namesHash: string;
};

export type ServerStatus = {
  name: string;
  state: string;
  stale: boolean;
  toolCount: number;
  lastError?: string | undefined;
  attempt: number;
  stderrTail: readonly string[];
};

export type CallOpts = {
  signal?: AbortSignal | undefined;
  onProgress?: ((p: { progress: number; total?: number; message?: string }) => void) | undefined;
  deadlineMs?: number | undefined;
  /** Resolved credential values, passed so redact() can strip them from any thrown error. */
  secrets?: readonly string[] | undefined;
};
```

- [ ] **Step 4: Write the failing error test**

`packages/core/src/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  PayloadTooLargeError,
  ToolUnavailableError,
  UpstreamUnavailableError,
  redact,
} from './errors.js';

describe('errors', () => {
  it('gives hidden, missing and disabled the same message', () => {
    const a = new ToolUnavailableError('github__create_issue');
    const b = new ToolUnavailableError('github__create_issue');
    expect(a.message).toBe(b.message);
    expect(a.message).toBe('Tool not found: github__create_issue');
    expect(a.code).toBe('TOOL_UNAVAILABLE');
  });

  it('carries the server and state on an upstream failure', () => {
    const e = new UpstreamUnavailableError('github', 'failed');
    expect(e.server).toBe('github');
    expect(e.state).toBe('failed');
    expect(e.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('redacts a resolved credential value out of a message', () => {
    const e = redact(new Error('upstream rejected token ghp_REAL_SECRET'), ['ghp_REAL_SECRET']);
    expect(e.message).not.toContain('ghp_REAL_SECRET');
    expect(e.message).toContain('[redacted]');
  });

  it('redacts the same value out of a nested cause and the stack', () => {
    const inner = new Error('bad header Bearer tok_ABC');
    const outer = new PayloadTooLargeError('wrapped: Bearer tok_ABC');
    outer.cause = inner;
    const e = redact(outer, ['tok_ABC']);
    expect(JSON.stringify({ m: e.message, s: e.stack, c: String(e.cause) })).not.toContain(
      'tok_ABC',
    );
  });

  it('is a no-op when there are no secrets to strip', () => {
    const e = new Error('plain');
    expect(redact(e, []).message).toBe('plain');
  });

  it('ignores empty-string secrets rather than redacting every character', () => {
    const e = redact(new Error('abc'), ['']);
    expect(e.message).toBe('abc');
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `pnpm vitest run --project unit packages/core/src/errors.test.ts`
Expected: FAIL — cannot resolve `./errors.js`.

- [ ] **Step 6: Implement the errors**

`packages/core/src/errors.ts`:

```ts
export class ToolUnavailableError extends Error {
  readonly code = 'TOOL_UNAVAILABLE';
  /** ONE template string, ONE construction site: hidden, missing and disabled are indistinguishable. */
  constructor(name: string) {
    super(`Tool not found: ${name}`);
    this.name = 'ToolUnavailableError';
  }
}

export class UpstreamUnavailableError extends Error {
  readonly code = 'UPSTREAM_UNAVAILABLE';
  constructor(
    readonly server: string,
    readonly state: string,
    cause?: Error,
  ) {
    super(`Upstream unavailable: ${server}`, cause ? { cause } : undefined);
    this.name = 'UpstreamUnavailableError';
  }
}

export class UpstreamAuthRequiredError extends Error {
  readonly code = 'UPSTREAM_AUTH_REQUIRED';
  constructor(
    readonly server: string,
    readonly authorizationUrl?: string,
  ) {
    super(`Upstream requires authorization: ${server}`);
    this.name = 'UpstreamAuthRequiredError';
  }
}

export class CredentialsRequiredError extends Error {
  readonly code = 'CREDENTIALS_REQUIRED';
  constructor(server: string) {
    super(`Credentials required: ${server}`);
    this.name = 'CredentialsRequiredError';
  }
}

export class UpstreamBusyError extends Error {
  readonly code = 'UPSTREAM_BUSY';
  constructor(server: string) {
    super(`Upstream busy: ${server}`);
    this.name = 'UpstreamBusyError';
  }
}

export class PayloadTooLargeError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE';
  constructor(message: string) {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

export class UnsafeUrlError extends Error {
  readonly code = 'UNSAFE_URL';
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/**
 * Applied to EVERY error leaving core. Strips any resolved credential value verbatim
 * from the message, the stack and the stringified cause chain. An empty secret is
 * ignored — `String.replaceAll('')` would otherwise splice the censor between every
 * character.
 */
export function redact(err: Error, secrets: readonly string[]): Error {
  const real = secrets.filter((s) => s.length > 0);
  if (real.length === 0) return err;
  const scrub = (s: string): string =>
    real.reduce((acc, secret) => acc.split(secret).join('[redacted]'), s);

  err.message = scrub(err.message);
  if (typeof err.stack === 'string') err.stack = scrub(err.stack);
  if (err.cause !== undefined) {
    err.cause =
      err.cause instanceof Error ? redact(err.cause, real) : new Error(scrub(String(err.cause)));
  }
  return err;
}
```

- [ ] **Step 7: Run the error tests**

Run: `pnpm vitest run --project unit packages/core/src/errors.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 8: Write the failing bus test**

`packages/core/src/bus.test.ts`:

```ts
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
```

- [ ] **Step 9: Run it and watch it fail**

Run: `pnpm vitest run --project unit packages/core/src/bus.test.ts`
Expected: FAIL — cannot resolve `./bus.js`.

- [ ] **Step 10: Implement the bus**

`packages/core/src/bus.ts`:

```ts
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
```

- [ ] **Step 11: Run the bus tests**

Run: `pnpm vitest run --project unit packages/core/src/bus.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 12: Verify the whole tree and commit**

`types.ts` is not yet imported by anything, so confirm `tsc` still emits it and nothing regressed:

```bash
pnpm build && pnpm lint && pnpm test
```

Expected: all three exit 0, `pnpm lint` with **zero** warnings.

```bash
git add packages/core/package.json packages/core/src/types.ts packages/core/src/errors.ts \
        packages/core/src/bus.ts packages/core/src/errors.test.ts packages/core/src/bus.test.ts \
        pnpm-lock.yaml
git commit -m "feat(core): engine types, the seven boundary errors, and a typed event bus"
```

---

### Task 2: The connection state machine

**Files:**

- Create: `packages/core/src/state.ts`
- Test: `packages/core/src/state.test.ts`

**Interfaces:**

- Consumes: nothing. This file imports only types — it is pure, has no I/O, no timers and no instance access.
- Produces:
  - `type State = 'disabled' | 'idle' | 'connecting' | 'discovering' | 'ready' | 'retrying' | 'authRequired' | 'failed' | 'stopping' | 'closed'`
  - `type Ev` — the 15 event objects below
  - `const TABLE` — the transition table, exported so the test can be generated from it
  - `function next(s: State, ev: Ev, intent: State): State | undefined` — `undefined` means "illegal pair, drop it". Never throws.

- [ ] **Step 1: Write the failing test**

The table is data, so the test is driven by the table rather than repeating it — a hand-written list of 90 pairs would drift from the implementation the first time a state is added.

`packages/core/src/state.test.ts`:

```ts
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
    expect(next('connecting', { t: 'connectFail', err: new Error('x'), permanent: true }, 'closed')).toBe(
      'failed',
    );
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run --project unit packages/core/src/state.test.ts`
Expected: FAIL — cannot resolve `./state.js`.

- [ ] **Step 3: Implement the state machine**

`packages/core/src/state.ts`:

```ts
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
    // A refresh re-discovers on a live connection and must be able to deliver the
    // result. Without this the swap is dropped and the catalog silently goes stale
    // after every listChanged. `discoverFail` stays illegal here on purpose: one
    // failed re-list should keep the last good catalog, not tear down a healthy
    // server — a dead connection arrives as `transportClose` instead.
    discoverOk: 'ready',
    transportClose: 'retrying',
    authChallenge: 'authRequired',
    stop: 'stopping',
    disable: 'stopping',
  },
  retrying: { backoffElapsed: 'connecting', giveUp: 'failed', stop: 'closed', disable: 'disabled' },
  authRequired: { authResolved: 'connecting', start: 'connecting', stop: 'closed', disable: 'disabled' },
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
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run --project unit packages/core/src/state.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/core/src/state.ts packages/core/src/state.test.ts
git commit -m "feat(core): table-driven upstream connection state machine"
```

---

### Task 3: The counting semaphore

**Files:**

- Create: `packages/core/src/semaphore.ts`
- Test: `packages/core/src/semaphore.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `class Semaphore { constructor(n: number); run<T>(fn: () => Promise<T>, deadlineMs?: number): Promise<T> }`. Gates BOTH startup connects (Task 8) and per-server call concurrency (Task 10). Releases in `finally`, so a throwing `fn` never leaks a permit.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run --project unit packages/core/src/semaphore.test.ts`
Expected: FAIL — cannot resolve `./semaphore.js`.

- [ ] **Step 3: Implement**

`packages/core/src/semaphore.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run --project unit packages/core/src/semaphore.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/core/src/semaphore.ts packages/core/src/semaphore.test.ts
git commit -m "feat(core): FIFO counting semaphore with a bounded acquisition wait"
```

---

### Task 4: The SSRF guard

**Files:**

- Create: `packages/core/src/ssrf.ts`
- Test: `packages/core/src/ssrf.test.ts`

**Interfaces:**

- Consumes: `UnsafeUrlError` (Task 1).
- Produces:
  - `assertSafeUrl(url: string, allowPrivate?: boolean): Promise<void>`
  - `guardedFetch(allowPrivate?: boolean): typeof fetch` — `redirect: 'manual'`, re-validates **every** hop, max 5.
  - `isBlockedIp(ip: string): boolean` — exported for the test, and the single place a range is listed.

**Design note (D12):** validation runs on the configured URL at connect time **and on every redirect hop**. There is **no owner-based bypass** — the only escape hatch is the explicit per-server `allowPrivateNetwork: true`, which the UI surfaces and every connect logs. mcphub's guard is correct but bypassed wholesale for admin-owned servers, and in a team self-host every server is admin-owned, so their guard is effectively off.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { assertSafeUrl, guardedFetch, isBlockedIp } from './ssrf.js';
import { UnsafeUrlError } from './errors.js';

describe('isBlockedIp', () => {
  const blocked = [
    '127.0.0.1',
    '127.9.9.9',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:10.0.0.1', // IPv4-mapped private
  ];
  const allowed = ['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.63.255.255', '2606:4700::1111'];

  it.each(blocked)('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(allowed)('allows %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  it('rejects a non-http scheme before any DNS lookup', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeUrl('gopher://x/')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects a literal loopback host', async () => {
    await expect(assertSafeUrl('http://127.0.0.1:8080/mcp')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects a hostname that resolves to loopback', async () => {
    await expect(assertSafeUrl('http://localhost:8080/mcp')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('allows a loopback host when the server opted in explicitly', async () => {
    await expect(assertSafeUrl('http://127.0.0.1:8080/mcp', true)).resolves.toBeUndefined();
  });

  it('never leaks the resolved address into the error message', async () => {
    const err = await assertSafeUrl('http://localhost/mcp').catch((e: Error) => e);
    expect(err.message).toContain('localhost');
    expect(err.message).not.toMatch(/\b127\.0\.0\.1\b/);
  });
});

describe('guardedFetch', () => {
  it('follows a safe redirect and returns the final response', async () => {
    const seen: string[] = [];
    const inner = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith('/a')) {
        return new Response(null, { status: 302, headers: { location: 'https://example.test/b' } });
      }
      return new Response('done', { status: 200 });
    };
    const f = guardedFetch(true, { fetchImpl: inner, resolve: async () => ['93.184.216.34'] });
    const res = await f('https://example.test/a');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('done');
    expect(seen).toEqual(['https://example.test/a', 'https://example.test/b']);
  });

  it('rejects a redirect that points at a private address', async () => {
    const inner = async (): Promise<Response> =>
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } });
    const f = guardedFetch(false, { fetchImpl: inner, resolve: async () => ['93.184.216.34'] });
    await expect(f('https://example.test/a')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('stops after 5 hops instead of following a redirect loop', async () => {
    let n = 0;
    const inner = async (): Promise<Response> => {
      n += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://example.test/${n}` },
      });
    };
    const f = guardedFetch(false, { fetchImpl: inner, resolve: async () => ['93.184.216.34'] });
    await expect(f('https://example.test/0')).rejects.toThrow(/redirect/i);
    expect(n).toBeLessThanOrEqual(6);
  });

  it('passes redirect:manual to the underlying fetch so it cannot follow on its own', async () => {
    let got: RequestInit | undefined;
    const inner = async (_i: unknown, init?: RequestInit): Promise<Response> => {
      got = init;
      return new Response('ok', { status: 200 });
    };
    const f = guardedFetch(false, { fetchImpl: inner, resolve: async () => ['93.184.216.34'] });
    await f('https://example.test/a');
    expect(got?.redirect).toBe('manual');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run --project unit packages/core/src/ssrf.test.ts`
Expected: FAIL — cannot resolve `./ssrf.js`.

- [ ] **Step 3: Implement**

`packages/core/src/ssrf.ts`:

```ts
import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import { UnsafeUrlError } from './errors.js';

const MAX_HOPS = 5;

/** Injection points exist so the unit test never touches the network. */
export type GuardDeps = {
  fetchImpl?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
};

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

function v4Blocked(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT RFC6598
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * The ONLY place a range is listed. IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is
 * unwrapped first — treating it as "some IPv6 address" is the classic bypass.
 */
export function isBlockedIp(ip: string): boolean {
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1] !== undefined) return v4Blocked(mapped[1]);
  if (isIPv4(lower)) return v4Blocked(lower);
  if (!isIPv6(lower)) return true; // not an address we understand -> refuse
  if (lower === '::' || lower === '::1') return true; // unspecified + loopback
  if (lower.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(lower)) return true; // unique local fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}

/**
 * Rejects a URL whose scheme is not http(s), or any of whose resolved addresses
 * is private/loopback/link-local/CGNAT. The error never contains the resolved
 * address: an SSRF probe must not be able to use our error text as a DNS oracle.
 */
export async function assertSafeUrl(
  url: string,
  allowPrivate?: boolean,
  deps: GuardDeps = {},
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrlError(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError(`Unsupported scheme: ${parsed.protocol.replace(':', '')}`);
  }
  if (allowPrivate === true) return;

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIPv4(host) || isIPv6(host) ? [host] : await resolveOrRefuse(host, deps);
  if (addresses.length === 0) throw new UnsafeUrlError(`Host does not resolve: ${parsed.hostname}`);
  if (addresses.some((ip) => isBlockedIp(ip))) {
    throw new UnsafeUrlError(`Host resolves to a non-public address: ${parsed.hostname}`);
  }
}

async function resolveOrRefuse(host: string, deps: GuardDeps): Promise<string[]> {
  try {
    return await (deps.resolve ?? defaultResolve)(host);
  } catch {
    throw new UnsafeUrlError(`Host does not resolve: ${host}`);
  }
}

/**
 * A `fetch` that refuses to follow a redirect it has not validated. `redirect:'manual'`
 * is load-bearing: with the default `'follow'` the platform chases the Location header
 * itself and our per-hop check never runs.
 */
export function guardedFetch(allowPrivate?: boolean, deps: GuardDeps = {}): typeof fetch {
  const impl = deps.fetchImpl ?? fetch;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    let target = typeof input === 'string' || input instanceof URL ? String(input) : input.url;

    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      await assertSafeUrl(target, allowPrivate, deps);
      const res = await impl(target, { ...init, redirect: 'manual' });
      if (res.status < 300 || res.status > 399) return res;

      const location = res.headers.get('location');
      if (location === null) return res;
      target = new URL(location, target).toString();
    }
    throw new UnsafeUrlError(`Too many redirects (max ${MAX_HOPS})`);
  }) as typeof fetch;
}
```

> **What this does NOT close, deliberately:** a DNS rebinding attack, where the name resolves to a public address for our check and a private one for the socket the transport then opens. Closing it requires pinning the validated address into the connection (a custom `undici` dispatcher). That is a P7 hardening item; `allowPrivateNetwork` and the per-hop check cover the realistic cases, and the gap is written down rather than assumed away.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run --project unit packages/core/src/ssrf.test.ts`
Expected: PASS — 19 `isBlockedIp` cases + 5 `assertSafeUrl` + 4 `guardedFetch`.

> The `localhost` cases use the real resolver on purpose: they are the only two that prove the DNS path is wired at all, and `localhost` resolves without leaving the machine.

- [ ] **Step 5: Commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/core/src/ssrf.ts packages/core/src/ssrf.test.ts
git commit -m "feat(core): SSRF guard validating the URL and every redirect hop"
```

---

### Task 5: The transport factory

**Files:**

- Create: `packages/core/src/transport.ts`
- Test: `packages/core/src/transport.test.ts`

**Interfaces:**

- Consumes: `ServerConfig` (Task 1), `assertSafeUrl` / `guardedFetch` (Task 4).
- Produces:
  - `type TransportFactory = (cfg: ServerConfig, ctx: TransportCtx) => Promise<Transport>`
  - `type TransportCtx = { headers: Record<string, string>; authProvider?: OAuthClientProvider; signal: AbortSignal; onStderr: (line: string) => void }`
  - `const createTransport: TransportFactory` — the real one
  - `function assertPlainStringMap(label: string, m: Record<string, unknown> | undefined): Record<string, string>` — Ruling P3's fail-closed guard
  - `function augmentPath(env: Record<string, string>): Record<string, string>`

**Carries Rulings P2 and P3.** No `${VAR}` expansion of any kind. A non-string env or header value is a named failure, never a stringification.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { assertPlainStringMap, augmentPath, createTransport } from './transport.js';
import { UnsafeUrlError } from './errors.js';
import type { ServerConfig } from './types.js';

const base = { enabled: true, credentialMode: 'shared' as const };

describe('assertPlainStringMap (Ruling P3)', () => {
  it('passes a plain string map through unchanged', () => {
    expect(assertPlainStringMap('env', { A: '1', B: 'two' })).toEqual({ A: '1', B: 'two' });
  });

  it('treats undefined as empty', () => {
    expect(assertPlainStringMap('env', undefined)).toEqual({});
  });

  it('refuses an unresolved {"$secret":...} rather than stringifying it', () => {
    expect(() =>
      assertPlainStringMap('env', { TOKEN: { $secret: 'abc' } as unknown as string }),
    ).toThrow(/TOKEN/);
  });

  it('names the offending key so the operator can find it', () => {
    const err = (() => {
      try {
        assertPlainStringMap('headers', { authorization: { $secret: 'x' } as unknown as string });
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toContain('headers');
    expect(err?.message).toContain('authorization');
  });

  it('does NOT expand ${VAR} — the value is passed through verbatim (Ruling P2)', () => {
    process.env['MCPR_TEST_LEAK'] = 'leaked-value';
    try {
      expect(assertPlainStringMap('env', { A: '${MCPR_TEST_LEAK}' })).toEqual({
        A: '${MCPR_TEST_LEAK}',
      });
    } finally {
      delete process.env['MCPR_TEST_LEAK'];
    }
  });
});

describe('augmentPath', () => {
  it('keeps the existing PATH and appends the common tool locations', () => {
    const out = augmentPath({ PATH: '/usr/bin' });
    expect(out['PATH']).toContain('/usr/bin');
    expect(out['PATH']).toContain('/usr/local/bin');
  });

  it('does not duplicate an entry already present', () => {
    const out = augmentPath({ PATH: '/usr/local/bin' });
    const hits = out['PATH']?.split(':').filter((p) => p === '/usr/local/bin').length;
    expect(hits).toBe(1);
  });
});

describe('createTransport', () => {
  const ctx = {
    headers: {},
    signal: new AbortController().signal,
    onStderr: () => {},
  };

  it('refuses an http upstream whose URL is private', async () => {
    const cfg: ServerConfig = {
      ...base,
      name: 'x',
      type: 'streamable-http',
      url: 'http://127.0.0.1:9/mcp',
    };
    await expect(createTransport(cfg, ctx)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses an sse upstream whose URL is private', async () => {
    const cfg: ServerConfig = { ...base, name: 'x', type: 'sse', url: 'http://10.0.0.1/mcp' };
    await expect(createTransport(cfg, ctx)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses a stdio upstream carrying an unresolved secret in env', async () => {
    const cfg = {
      ...base,
      name: 'x',
      type: 'stdio' as const,
      command: 'node',
      env: { TOKEN: { $secret: 'abc' } as unknown as string },
    };
    await expect(createTransport(cfg, ctx)).rejects.toThrow(/TOKEN/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run --project unit packages/core/src/transport.test.ts`
Expected: FAIL — cannot resolve `./transport.js`.

- [ ] **Step 3: Implement**

`packages/core/src/transport.ts`:

```ts
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { assertSafeUrl, guardedFetch } from './ssrf.js';
import type { ServerConfig } from './types.js';

export type TransportCtx = {
  /** Config headers already merged with any resolved per-user headers. */
  headers: Record<string, string>;
  authProvider?: OAuthClientProvider | undefined;
  /** Aborted when stop() lands mid-connect. */
  signal: AbortSignal;
  onStderr: (line: string) => void;
};

export type TransportFactory = (cfg: ServerConfig, ctx: TransportCtx) => Promise<Transport>;

/** Paths a GUI-launched or container process routinely lacks but npx/uvx live in. */
const EXTRA_PATHS = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];

export function augmentPath(env: Record<string, string>): Record<string, string> {
  const current = (env['PATH'] ?? '').split(':').filter((p) => p.length > 0);
  for (const p of EXTRA_PATHS) if (!current.includes(p)) current.push(p);
  return { ...env, PATH: current.join(':') };
}

/**
 * Ruling P2: values are passed through VERBATIM. There is no `${VAR}` expansion,
 * because expanding from process.env is exactly how a secret ends up inside a
 * config file (spec §5.4).
 *
 * Ruling P3: a non-string value means an unresolved `{"$secret":…}` reached the
 * transport. Stringifying it would spawn the upstream with the literal text
 * `[object Object]` as its token — a server that connects but is silently
 * unauthenticated. Fail closed and name the key instead.
 */
export function assertPlainStringMap(
  label: string,
  m: Record<string, unknown> | undefined,
): Record<string, string> {
  if (m === undefined) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v !== 'string') {
      throw new TypeError(
        `Unresolved value for ${label}.${k}: expected a string, got ${typeof v}. ` +
          'A {"$secret":…} reference must be resolved before it reaches the transport.',
      );
    }
    out[k] = v;
  }
  return out;
}

export const createTransport: TransportFactory = async (cfg, ctx) => {
  switch (cfg.type) {
    case 'stdio': {
      const env = assertPlainStringMap('env', cfg.env);
      return new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: { ...augmentPath(getDefaultEnvironment()), ...env },
        ...(cfg.cwd === undefined ? {} : { cwd: cfg.cwd }),
        stderr: 'pipe',
      });
    }
    case 'streamable-http': {
      await assertSafeUrl(cfg.url, cfg.allowPrivateNetwork);
      const headers = { ...assertPlainStringMap('headers', cfg.headers), ...ctx.headers };
      return new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: { headers },
        ...(ctx.authProvider === undefined ? {} : { authProvider: ctx.authProvider }),
        fetch: guardedFetch(cfg.allowPrivateNetwork),
      });
    }
    case 'sse': {
      await assertSafeUrl(cfg.url, cfg.allowPrivateNetwork);
      const headers = { ...assertPlainStringMap('headers', cfg.headers), ...ctx.headers };
      return new SSEClientTransport(new URL(cfg.url), {
        requestInit: { headers },
        ...(ctx.authProvider === undefined ? {} : { authProvider: ctx.authProvider }),
        fetch: guardedFetch(cfg.allowPrivateNetwork),
      });
    }
  }
};
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run --project unit packages/core/src/transport.test.ts`
Expected: PASS, 10 tests.

> If the SDK's `StdioClientTransport` options type rejects `stderr: 'pipe'` or the `cwd` spread, read `node_modules/.pnpm/@modelcontextprotocol+sdk@1.30.0/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.d.ts` and match the real shape. Do not cast to `any` — `exactOptionalPropertyTypes` is on for a reason, and the conditional spread above is the pattern that satisfies it.

- [ ] **Step 5: Commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/core/src/transport.ts packages/core/src/transport.test.ts
git commit -m "feat(core): transport factory for stdio, streamable-http and sse

Values are passed through verbatim: there is no \${VAR} expansion, because
expanding from process.env is how a secret ends up in a config file (spec 5.4),
and a non-string value fails the server closed rather than spawning it with the
text [object Object] as its token."
```

---

### Task 6: The fake upstream test seam

**Files:**

- Create: `packages/core/test/fake-upstream.ts`
- Test: `packages/core/test/fake-upstream.test.ts`

**Interfaces:**

- Consumes: `TransportFactory`, `TransportCtx` (Task 5).
- Produces:
  - `class FakeUpstream` — a REAL `McpServer` over `InMemoryTransport`, with knobs
  - `function fakeFactory(fakes: Record<string, FakeUpstream>): TransportFactory`

This is the seam that makes Tasks 7–11 testable with no child processes and no ports. Every later test drives the engine through it.

- [ ] **Step 1: Write the fake**

`packages/core/test/fake-upstream.ts`:

```ts
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { TransportFactory } from '../src/transport.js';

export type FakeTool = {
  name: string;
  description?: string;
  handler?: (args: Record<string, unknown>) => Promise<string> | string;
};

export type FakeKnobs = {
  /** Delay before connect resolves, to exercise the connect semaphore. */
  connectDelayMs?: number;
  /** 'permanent' -> never retry; 'transient' -> retryable. */
  failConnect?: 'permanent' | 'transient' | undefined;
  /** Throw a 401-shaped error so the engine reaches authRequired. */
  authChallenge?: boolean;
};

/**
 * A REAL MCP server over InMemoryTransport — no child process, no port, sub-ms.
 *
 * It uses the low-level `Server` with the SDK's own request schemas rather than
 * `McpServer.registerTool`, for two reasons: `registerTool`'s inputSchema is
 * zod-typed and zod is deliberately not reachable from packages/core, and the
 * raw handler receives `arguments` verbatim, which is what lets a test prove an
 * argument actually crossed the wire.
 */
export class FakeUpstream {
  #tools: FakeTool[];
  #connects = 0;
  #closed = false;
  #live: Server | undefined;

  constructor(
    readonly name: string,
    tools: FakeTool[] = [],
    readonly knobs: FakeKnobs = {},
  ) {
    this.#tools = tools;
  }

  get connects(): number {
    return this.#connects;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #build(): Server {
    const server = new Server(
      { name: this.name, version: '0.0.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.#tools.map((t) => ({
        name: t.name,
        description: t.description ?? `fake ${t.name}`,
        inputSchema: { type: 'object' as const, properties: {} },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = this.#tools.find((t) => t.name === request.params.name);
      if (tool === undefined) throw new Error(`no such tool: ${request.params.name}`);
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      return {
        content: [
          {
            type: 'text' as const,
            text: tool.handler === undefined ? `${tool.name}:ok` : await tool.handler(args),
          },
        ],
      };
    });
    return server;
  }

  /** Replace the tool set and announce it, to exercise listChanged handling. */
  setTools(tools: FakeTool[]): void {
    this.#tools = tools;
    void this.#live?.sendToolListChanged();
  }

  /** Kill the connection from the upstream side, to drive reconnect + backoff. */
  async drop(): Promise<void> {
    await this.#live?.close();
  }

  /** A fresh Server per connect: one Protocol instance cannot be reconnected. */
  async connect(): Promise<Transport> {
    this.#connects += 1;
    if (this.knobs.connectDelayMs !== undefined) {
      await new Promise((r) => setTimeout(r, this.knobs.connectDelayMs));
    }
    if (this.knobs.authChallenge === true) {
      throw Object.assign(new Error('Unauthorized'), { code: 401 });
    }
    if (this.knobs.failConnect !== undefined) {
      throw Object.assign(new Error(`fake ${this.knobs.failConnect} connect failure`), {
        permanent: this.knobs.failConnect === 'permanent',
      });
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = this.#build();
    await server.connect(serverSide);
    this.#live = server;

    const origClose = clientSide.close.bind(clientSide);
    clientSide.close = async () => {
      this.#closed = true;
      await origClose();
    };
    return clientSide;
  }
}

/** Drop-in replacement for `createTransport` in every engine test. */
export function fakeFactory(fakes: Record<string, FakeUpstream>): TransportFactory {
  return async (cfg) => {
    const fake = fakes[cfg.name];
    if (fake === undefined) throw new Error(`no fake upstream registered for ${cfg.name}`);
    return fake.connect();
  };
}
```

- [ ] **Step 2: Write a test that proves the fake is a real MCP server**

A fake that does not behave like the protocol would let every later test pass against a fiction.

`packages/core/test/fake-upstream.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { FakeUpstream } from './fake-upstream.js';

describe('fake upstream', () => {
  it('speaks real MCP: a real Client can list and call its tools', async () => {
    const fake = new FakeUpstream('fs', [
      { name: 'read_file', description: 'reads a file' },
      { name: 'write_file', handler: (a) => `wrote ${String(a['path'])}` },
    ]);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(await fake.connect());

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(['read_file', 'write_file']);

    const result = await client.callTool({ name: 'write_file', arguments: { path: '/tmp/x' } });
    expect(JSON.stringify(result.content)).toContain('wrote /tmp/x');

    await client.close();
  });

  it('counts connects so a test can assert a reconnect happened', async () => {
    const fake = new FakeUpstream('fs', []);
    await fake.connect();
    await fake.connect();
    expect(fake.connects).toBe(2);
  });

  it('reports a permanent connect failure distinguishably', async () => {
    const fake = new FakeUpstream('bad', [], { failConnect: 'permanent' });
    const err = await fake.connect().catch((e: Error & { permanent?: boolean }) => e);
    expect((err as { permanent?: boolean }).permanent).toBe(true);
  });
});
```

- [ ] **Step 3: Run it**

Run: `pnpm vitest run --project unit packages/core/test/fake-upstream.test.ts`
Expected: PASS, 3 tests.

> `vitest.config.ts`'s unit project includes `packages/*/src/**/*.test.ts` only — this test lives under `test/`, so **add `packages/*/test/**/*.test.ts` to the unit project's `include` array** in the same step, and confirm the file actually runs (the run above must report 3 tests, not "No test files found"). Coverage `include` stays `packages/*/src/**/*.ts`, so the helper itself is correctly not counted.

- [ ] **Step 4: Commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/core/test/fake-upstream.ts packages/core/test/fake-upstream.test.ts vitest.config.ts
git commit -m "test(core): in-process fake upstream over InMemoryTransport"
```

---

### Task 7: UpstreamServer — one live connection

**Files:**

- Modify: `packages/core/src/bus.ts` (add `EngineEvents`)
- Create: `packages/core/src/upstream-server.ts`
- Test: `packages/core/test/upstream-server.test.ts`

**Interfaces:**

- Consumes: `Bus` (T1), `next`/`State`/`Ev` (T2), `Semaphore` (T3), `TransportFactory` (T5), `FakeUpstream`/`fakeFactory` (T6).
- Produces:
  - `type EngineEvents` — the six event shapes, exported from `bus.ts`
  - `class UpstreamServer` with `key`, `name`, `configHash`, `state`, `catalog`, `stale`, `stderrTail`, `attempt`, `lastError`, and `start()` / `ensureReady(deadlineMs?)` / `stop(intent)` / `refresh()` / `callTool()` / `getPrompt()` / `readResource()`
  - `function configHashOf(cfg: ServerConfig): string`

**Carries Ruling P4:** `stopping` drops every event except `stopped`, so a re-entrant `stop()` must return the in-flight promise rather than dispatch again.

- [ ] **Step 1: Add EngineEvents to the bus**

Append to `packages/core/src/bus.ts`:

```ts
import type { State } from './state.js';

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
```

- [ ] **Step 2: Write the failing test**

`packages/core/test/upstream-server.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bus, type EngineEvents } from '../src/bus.js';
import { Semaphore } from '../src/semaphore.js';
import { UpstreamServer, configHashOf } from '../src/upstream-server.js';
import { UpstreamUnavailableError } from '../src/errors.js';
import type { ServerConfig } from '../src/types.js';
import { FakeUpstream, fakeFactory } from './fake-upstream.js';

const cfg = (over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    name: 'fs',
    enabled: true,
    credentialMode: 'shared',
    type: 'stdio',
    command: 'node',
    ...over,
  }) as ServerConfig;

function make(fake: FakeUpstream, c: ServerConfig = cfg()) {
  const bus = new Bus<EngineEvents>();
  const states: string[] = [];
  bus.on('server:state', (e) => states.push(e.to));
  const srv = new UpstreamServer({
    config: c,
    key: c.name,
    bus,
    connect: fakeFactory({ [c.name]: fake }),
    connectSem: new Semaphore(4),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { srv, bus, states };
}

describe('UpstreamServer', () => {
  it('reaches ready and exposes the discovered catalog', async () => {
    const fake = new FakeUpstream('fs', [{ name: 'read_file' }, { name: 'write_file' }]);
    const { srv, states } = make(fake);
    srv.start();
    await srv.ensureReady(2000);

    expect(srv.state).toBe('ready');
    expect([...(srv.catalog?.tools.keys() ?? [])].sort()).toEqual(['read_file', 'write_file']);
    expect(states).toContain('connecting');
    expect(states).toContain('discovering');
    expect(states).toContain('ready');
    await srv.stop('closed');
  });

  it('applies a per-tool description override at cache time, not at list time', async () => {
    const fake = new FakeUpstream('fs', [{ name: 'read_file', description: 'upstream text' }]);
    const { srv } = make(fake, cfg({ tools: { read_file: { description: 'our text' } } }));
    srv.start();
    await srv.ensureReady(2000);
    expect(srv.catalog?.tools.get('read_file')?.description).toBe('our text');
    await srv.stop('closed');
  });

  it('a permanent connect failure lands in failed and never retries', async () => {
    vi.useFakeTimers();
    const fake = new FakeUpstream('fs', [], { failConnect: 'permanent' });
    const { srv } = make(fake);
    srv.start();
    await vi.waitFor(() => expect(srv.state).toBe('failed'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.connects).toBe(1);
    await srv.stop('closed');
  });

  it('a transient failure retries with backoff and eventually succeeds', async () => {
    vi.useFakeTimers();
    const fake = new FakeUpstream('fs', [{ name: 't' }], { failConnect: 'transient' });
    const { srv } = make(fake);
    srv.start();
    await vi.waitFor(() => expect(srv.state).toBe('retrying'));

    // Let it succeed on the next attempt.
    (fake.knobs as { failConnect?: string }).failConnect = undefined;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(srv.state).toBe('ready'));
    expect(fake.connects).toBeGreaterThanOrEqual(2);
    await srv.stop('closed');
  });

  it('keeps serving the previous catalog while reconnecting, marked stale', async () => {
    vi.useFakeTimers();
    const fake = new FakeUpstream('fs', [{ name: 't' }]);
    const { srv } = make(fake);
    srv.start();
    await vi.waitFor(() => expect(srv.state).toBe('ready'));

    await fake.drop();
    await vi.waitFor(() => expect(srv.state).toBe('retrying'));
    expect(srv.stale).toBe(true);
    expect(srv.catalog?.tools.has('t')).toBe(true); // still served
    await srv.stop('closed');
  });

  it('ensureReady rejects rather than hanging when the server is failed', async () => {
    const fake = new FakeUpstream('fs', [], { failConnect: 'permanent' });
    const { srv } = make(fake);
    srv.start();
    await expect(srv.ensureReady(2000)).rejects.toBeInstanceOf(UpstreamUnavailableError);
    await srv.stop('closed');
  });

  it('a second stop() returns the same promise instead of hanging (Ruling P4)', async () => {
    const fake = new FakeUpstream('fs', [{ name: 't' }]);
    const { srv } = make(fake);
    srv.start();
    await srv.ensureReady(2000);

    const a = srv.stop('closed');
    const b = srv.stop('closed');
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
    expect(srv.state).toBe('closed');
  });

  it('closed is terminal: a later start() does not reconnect', async () => {
    const fake = new FakeUpstream('fs', [{ name: 't' }]);
    const { srv } = make(fake);
    srv.start();
    await srv.ensureReady(2000);
    await srv.stop('closed');
    const before = fake.connects;
    srv.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.connects).toBe(before);
  });

  it('configHashOf is stable across key order and changes with a value', () => {
    const a = configHashOf(cfg({ tools: { x: { enabled: true }, y: { enabled: false } } }));
    const b = configHashOf(cfg({ tools: { y: { enabled: false }, x: { enabled: true } } }));
    expect(a).toBe(b);
    expect(configHashOf(cfg({ command: 'other' }))).not.toBe(a);
  });

  it('bounds the stderr ring at 200 lines', async () => {
    const fake = new FakeUpstream('fs', [{ name: 't' }]);
    const { srv } = make(fake);
    for (let i = 0; i < 250; i += 1) srv.pushStderrForTest(`line ${i}`);
    expect(srv.stderrTail).toHaveLength(200);
    expect(srv.stderrTail[199]).toBe('line 249');
  });
});

afterEach(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  vi.clearAllTimers?.();
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run --project unit packages/core/test/upstream-server.test.ts`
Expected: FAIL — cannot resolve `../src/upstream-server.js`.

- [ ] **Step 4: Implement**

`packages/core/src/upstream-server.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Bus, EngineEvents } from './bus.js';
import { UpstreamAuthRequiredError, UpstreamUnavailableError } from './errors.js';
import type { Semaphore } from './semaphore.js';
import { next, type Ev, type State } from './state.js';
import type { TransportFactory } from './transport.js';
import type {
  CallOpts,
  Prompt,
  Resource,
  ResourceTemplate,
  ServerCatalog,
  ServerConfig,
  Tool,
} from './types.js';

const STDERR_RING = 200;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = Number(process.env['MCPROUTER_RETRY_MAX_MS'] ?? 30_000);
const RETRY_MAX_ATTEMPTS = Number(process.env['MCPROUTER_RETRY_MAX_ATTEMPTS'] ?? 0);

export type MiniLogger = {
  debug: (o: unknown, m?: string) => void;
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
};

export type UpstreamServerOpts = {
  config: ServerConfig;
  /** `${name}` for the shared instance, `${name}#${principalId}:${revision}` per-user. */
  key: string;
  bus: Bus<EngineEvents>;
  connect: TransportFactory;
  connectSem: Semaphore;
  logger: MiniLogger;
  /** Extra headers for a per-user instance. */
  headers?: Record<string, string>;
};

/** Stable across key order, so a cosmetic config rewrite does not restart a server. */
export function configHashOf(cfg: ServerConfig): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, canon(val)]),
      );
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canon(cfg))).digest('hex');
}

/** Errors we must never retry: retrying cannot change the answer. */
function isPermanent(err: unknown): boolean {
  const e = err as { permanent?: boolean; code?: unknown; message?: string };
  if (typeof e.permanent === 'boolean') return e.permanent;
  const code = String(e.code ?? '');
  if (['ENOENT', 'EACCES', 'ENOTDIR', 'ENOTFOUND', 'UNSAFE_URL'].includes(code)) return true;
  if (code === '404') return true;
  return /Unsupported scheme|non-public address|Unresolved value for/.test(e.message ?? '');
}

function isAuthChallenge(err: unknown): boolean {
  const e = err as { code?: unknown; message?: string };
  return String(e.code ?? '') === '401' || /unauthor/i.test(e.message ?? '');
}

export class UpstreamServer {
  readonly key: string;
  readonly name: string;
  readonly config: ServerConfig;
  readonly configHash: string;

  #state: State;
  #intent: State = 'closed';
  #catalog: ServerCatalog | undefined;
  #stale = false;
  #attempt = 0;
  #lastError: Error | undefined;
  #epoch = 0;
  #client: Client | undefined;
  #transport: Transport | undefined;
  #abort: AbortController | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopping: Promise<void> | undefined;
  readonly #stderr: string[] = [];
  readonly #o: UpstreamServerOpts;

  constructor(o: UpstreamServerOpts) {
    this.#o = o;
    this.key = o.key;
    this.name = o.config.name;
    this.config = o.config;
    this.configHash = configHashOf(o.config);
    this.#state = o.config.enabled ? 'idle' : 'disabled';
  }

  get state(): State {
    return this.#state;
  }
  get catalog(): ServerCatalog | undefined {
    return this.#catalog;
  }
  /** A ready catalog being served while we reconnect underneath (D14). */
  get stale(): boolean {
    return this.#stale;
  }
  get attempt(): number {
    return this.#attempt;
  }
  get lastError(): Error | undefined {
    return this.#lastError;
  }
  get stderrTail(): readonly string[] {
    return this.#stderr;
  }

  /** Exposed for the ring-buffer test; the transport calls this via onStderr. */
  pushStderrForTest(line: string): void {
    this.#pushStderr(line);
  }

  #pushStderr(line: string): void {
    this.#stderr.push(line);
    while (this.#stderr.length > STDERR_RING) this.#stderr.shift();
    this.#o.bus.emit('upstream:log', {
      name: this.name,
      stream: 'stderr',
      level: 'info',
      message: line,
    });
  }

  start(): void {
    this.#dispatch({ t: 'start' });
  }

  refresh(): void {
    this.#dispatch({ t: 'refresh' });
  }

  async ensureReady(deadlineMs = 30_000): Promise<void> {
    if (this.#state === 'ready') return;
    if (this.#state === 'failed' || this.#state === 'disabled' || this.#state === 'closed') {
      throw new UpstreamUnavailableError(this.name, this.#state, this.#lastError);
    }
    if (this.#state === 'authRequired') throw new UpstreamAuthRequiredError(this.name);
    if (this.#state === 'idle') this.start();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new UpstreamUnavailableError(this.name, this.#state, this.#lastError));
      }, deadlineMs);
      timer.unref?.();
      const off = this.#o.bus.on('server:state', (e) => {
        if (e.key !== this.key) return;
        if (e.to === 'ready') {
          clearTimeout(timer);
          off();
          resolve();
        } else if (e.to === 'failed' || e.to === 'disabled' || e.to === 'closed') {
          clearTimeout(timer);
          off();
          reject(new UpstreamUnavailableError(this.name, e.to, this.#lastError));
        } else if (e.to === 'authRequired') {
          clearTimeout(timer);
          off();
          reject(new UpstreamAuthRequiredError(this.name, e.authorizationUrl));
        }
      });
    });
  }

  /**
   * Ruling P4: `stopping` drops a second `stop`, so re-entry must join the
   * in-flight teardown instead of dispatching an event the table will discard.
   */
  stop(intent: 'closed' | 'disabled' | 'idle'): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping;
    if (this.#state === 'closed') return Promise.resolve();
    this.#intent = intent;
    this.#stopping = this.#teardown(intent).finally(() => {
      this.#stopping = undefined;
    });
    return this.#stopping;
  }

  async #teardown(intent: 'closed' | 'disabled' | 'idle'): Promise<void> {
    this.#epoch += 1;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#abort?.abort();
    this.#dispatch({ t: 'stop', intent });
    try {
      await this.#client?.close();
    } catch {
      /* closing a dead transport is not an error */
    }
    this.#client = undefined;
    this.#transport = undefined;
    // If the table refused the `stop` (idle/failed/disabled go straight to their
    // target), the state is already final and `stopped` is a no-op.
    this.#dispatch({ t: 'stopped' });
    if (this.#state !== intent) this.#setState(intent);
  }

  // ---- the ONLY mutator of #state -------------------------------------------

  #dispatch(ev: Ev): void {
    const to = next(this.#state, ev, this.#intent);
    if (to === undefined) {
      this.#o.logger.debug({ evt: 'state.drop', key: this.key, state: this.#state, ev: ev.t });
      return;
    }
    if (ev.t === 'discoverOk') this.#swapCatalog(ev.catalog);
    if (ev.t === 'connectFail' || ev.t === 'discoverFail') this.#lastError = ev.err;
    this.#setState(to, ev);
    this.#onEnter(to, ev);
  }

  #setState(to: State, ev?: Ev): void {
    const from = this.#state;
    if (from === to && to !== 'ready') return;
    this.#state = to;
    const error =
      this.#lastError === undefined
        ? undefined
        : { code: String((this.#lastError as { code?: string }).code ?? 'ERROR'), message: this.#lastError.message };
    this.#o.bus.emit('server:state', {
      name: this.name,
      key: this.key,
      from,
      to,
      attempt: this.#attempt,
      ...(error === undefined ? {} : { error }),
      ...(ev?.t === 'authChallenge' && ev.authorizationUrl !== undefined
        ? { authorizationUrl: ev.authorizationUrl }
        : {}),
    });
  }

  #onEnter(to: State, _ev: Ev): void {
    switch (to) {
      case 'connecting':
        void this.#doConnect();
        return;
      case 'ready':
        this.#stale = false;
        this.#attempt = 0;
        return;
      case 'retrying':
        this.#stale = this.#catalog !== undefined;
        this.#scheduleBackoff();
        return;
      default:
        return;
    }
  }

  #scheduleBackoff(): void {
    this.#attempt += 1;
    if (RETRY_MAX_ATTEMPTS > 0 && this.#attempt > RETRY_MAX_ATTEMPTS) {
      this.#dispatch({ t: 'giveUp' });
      return;
    }
    const ceiling = Math.min(RETRY_BASE_MS * 2 ** (this.#attempt - 1), RETRY_MAX_MS);
    const delay = Math.random() * ceiling; // full jitter
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#dispatch({ t: 'backoffElapsed' }), delay);
    this.#timer.unref?.();
  }

  async #doConnect(): Promise<void> {
    this.#epoch += 1;
    const epoch = this.#epoch;
    const abort = new AbortController();
    this.#abort = abort;

    try {
      const transport = await this.#o.connectSem.run(() =>
        this.#o.connect(this.config, {
          headers: this.#o.headers ?? {},
          signal: abort.signal,
          onStderr: (line) => this.#pushStderr(line),
        }),
      );
      // The identity guard: a config change superseded us while we were waiting.
      if (epoch !== this.#epoch) {
        await transport.close().catch(() => {});
        return;
      }
      const client = new Client({ name: 'mcprouter', version: '0.0.0' });
      client.onclose = () => {
        if (epoch !== this.#epoch) return;
        this.#dispatch({ t: 'transportClose' });
      };
      await client.connect(transport);
      if (epoch !== this.#epoch) {
        await client.close().catch(() => {});
        return;
      }
      this.#client = client;
      this.#transport = transport;
      this.#dispatch({ t: 'connectOk' });
      await this.#discover(epoch);
    } catch (err) {
      if (epoch !== this.#epoch) return;
      const e = err instanceof Error ? err : new Error(String(err));
      if (isAuthChallenge(e)) {
        this.#dispatch({ t: 'authChallenge' });
        return;
      }
      this.#dispatch({ t: 'connectFail', err: e, permanent: isPermanent(e) });
    }
  }

  async #discover(epoch: number): Promise<void> {
    const client = this.#client;
    if (client === undefined) return;
    try {
      const caps = client.getServerCapabilities() ?? {};
      const tools = caps.tools === undefined ? [] : (await client.listTools()).tools;
      const prompts = caps.prompts === undefined ? [] : (await client.listPrompts()).prompts;
      const resources = caps.resources === undefined ? [] : (await client.listResources()).resources;
      const templates =
        caps.resources === undefined ? [] : (await client.listResourceTemplates()).resourceTemplates;
      if (epoch !== this.#epoch) return;

      this.#dispatch({
        t: 'discoverOk',
        catalog: this.#buildCatalog(tools, prompts, resources, templates, caps),
      });
    } catch (err) {
      if (epoch !== this.#epoch) return;
      const e = err instanceof Error ? err : new Error(String(err));
      this.#dispatch({ t: 'discoverFail', err: e, permanent: isPermanent(e) });
    }
  }

  /**
   * Description overrides are applied HERE, once, at cache time — so the projected
   * list, the context-cost figure and the P5 embedding text all see the same
   * effective description. Applying them at list time is how mcphub ends up
   * embedding the unedited upstream text.
   */
  #buildCatalog(
    tools: Tool[],
    prompts: Prompt[],
    resources: Resource[],
    resourceTemplates: ResourceTemplate[],
    capabilities: ServerCatalog['capabilities'],
  ): ServerCatalog {
    const overrides = this.config.tools ?? {};
    const toolMap = new Map<string, Tool>(
      tools.map((t) => {
        const override = overrides[t.name]?.description;
        return [t.name, override === undefined ? t : { ...t, description: override }];
      }),
    );
    const names = [
      ...[...toolMap.keys()].sort(),
      ...prompts.map((p) => p.name).sort(),
      ...resources.map((r) => r.uri).sort(),
    ].join('\u001f');
    return {
      tools: toolMap,
      prompts: new Map(prompts.map((p) => [p.name, p])),
      resources,
      resourceTemplates,
      capabilities,
      fetchedAt: Date.now(),
      namesHash: createHash('sha256').update(names).digest('hex'),
    };
  }

  #swapCatalog(catalog: ServerCatalog): void {
    const changed = this.#catalog?.namesHash !== catalog.namesHash;
    // Single assignment: Node is single-threaded, so this is atomic. No lock.
    this.#catalog = catalog;
    this.#o.bus.emit('server:catalog', {
      name: this.name,
      changed,
      tools: catalog.tools.size,
      prompts: catalog.prompts.size,
      resources: catalog.resources.length,
      fetchedAt: catalog.fetchedAt,
    });
  }

  // ---- upstream calls --------------------------------------------------------

  #requireClient(): Client {
    if (this.#client === undefined || this.#state !== 'ready') {
      throw new UpstreamUnavailableError(this.name, this.#state, this.#lastError);
    }
    return this.#client;
  }

  /** True when we can prove the request never left us (D11's retry gate). */
  get connected(): boolean {
    return this.#client !== undefined && this.#state === 'ready';
  }

  async callTool(bare: string, args: unknown, o: CallOpts): Promise<unknown> {
    return this.#requireClient().callTool(
      { name: bare, arguments: (args ?? {}) as Record<string, unknown> },
      undefined,
      this.#reqOpts(o),
    );
  }

  async getPrompt(bare: string, args: unknown, o: CallOpts): Promise<unknown> {
    return this.#requireClient().getPrompt(
      { name: bare, arguments: (args ?? {}) as Record<string, string> },
      this.#reqOpts(o),
    );
  }

  async readResource(uri: string, o: CallOpts): Promise<unknown> {
    return this.#requireClient().readResource({ uri }, this.#reqOpts(o));
  }

  #reqOpts(o: CallOpts): Record<string, unknown> {
    return {
      ...(o.signal === undefined ? {} : { signal: o.signal }),
      ...(o.onProgress === undefined ? {} : { onprogress: o.onProgress }),
      timeout: o.deadlineMs ?? Number(process.env['MCPROUTER_REQUEST_TIMEOUT_MS'] ?? 60_000),
      resetTimeoutOnProgress: true,
    };
  }

  /** Unused today; kept so call.ts can tag a call id without importing crypto. */
  static newCallId(): string {
    return randomUUID();
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run --project unit packages/core/test/upstream-server.test.ts`
Expected: PASS, 10 tests.

> The SDK's `Client` request-option names (`onprogress`, `resetTimeoutOnProgress`, `timeout`) and `getServerCapabilities()` must be checked against `dist/esm/shared/protocol.d.ts` and `dist/esm/client/index.d.ts` in the installed package. Fix the call sites to match the real signatures rather than casting.

- [ ] **Step 6: Commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/core/src/bus.ts packages/core/src/upstream-server.ts \
        packages/core/test/upstream-server.test.ts
git commit -m "feat(core): UpstreamServer lifecycle with epoch guard and stale-catalog serving"
```

---

### Task 8: ServerRegistry — the config diff

**Files:**

- Create: `packages/core/src/registry.ts`
- Test: `packages/core/test/registry.test.ts`

**Interfaces:**

- Consumes: `UpstreamServer`, `configHashOf` (T7), `Semaphore` (T3), `Bus` (T1).
- Produces:
  - `class ServerRegistry` with `generation`, `catalogVersion`, `applyConfig(configs)`, `shared(name)`, `lease(name, principal)`, `list()`, `shutdown()`

**Carries Ruling P5:** `catalogVersion` must increment on every `server:catalog` emit, not only on `applyConfig`, or Task 9's memo serves a stale tool list after a `listChanged` refresh.

- [ ] **Step 1: Write the failing test**

`packages/core/test/registry.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { Bus, type EngineEvents } from '../src/bus.js';
import { ServerRegistry } from '../src/registry.js';
import { CredentialsRequiredError } from '../src/errors.js';
import type { Principal, ServerConfig } from '../src/types.js';
import { FakeUpstream, fakeFactory } from './fake-upstream.js';

const cfg = (name: string, over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    name,
    enabled: true,
    credentialMode: 'shared',
    type: 'stdio',
    command: 'node',
    ...over,
  }) as ServerConfig;

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function make(fakes: Record<string, FakeUpstream>) {
  const bus = new Bus<EngineEvents>();
  const reg = new ServerRegistry({
    bus,
    connect: fakeFactory(fakes),
    logger,
    connectConcurrency: 2,
  });
  return { reg, bus };
}

const admin: Principal = { id: 'u1', isAdmin: true };

describe('ServerRegistry', () => {
  it('adds servers and bumps the generation once per applyConfig', async () => {
    const { reg } = make({ a: new FakeUpstream('a', [{ name: 't' }]) });
    await reg.applyConfig([cfg('a')]);
    expect(reg.generation).toBe(1);
    expect(reg.shared('a')).toBeDefined();
    await reg.shutdown();
  });

  it('leaves an unchanged server completely untouched across applyConfig', async () => {
    const fa = new FakeUpstream('a', [{ name: 't' }]);
    const { reg } = make({ a: fa, b: new FakeUpstream('b', []) });
    await reg.applyConfig([cfg('a')]);
    const first = reg.shared('a');
    const connects = fa.connects;

    await reg.applyConfig([cfg('a'), cfg('b')]);
    expect(reg.shared('a')).toBe(first); // same instance
    expect(fa.connects).toBe(connects); // not reconnected
    await reg.shutdown();
  });

  it('replaces a server whose config actually changed', async () => {
    const fa = new FakeUpstream('a', [{ name: 't' }]);
    const { reg } = make({ a: fa });
    await reg.applyConfig([cfg('a')]);
    const first = reg.shared('a');
    await reg.applyConfig([cfg('a', { command: 'other' })]);
    expect(reg.shared('a')).not.toBe(first);
    await reg.shutdown();
  });

  it('removes a server that disappeared from the config', async () => {
    const { reg } = make({ a: new FakeUpstream('a', []), b: new FakeUpstream('b', []) });
    await reg.applyConfig([cfg('a'), cfg('b')]);
    await reg.applyConfig([cfg('a')]);
    expect(reg.shared('b')).toBeUndefined();
    await reg.shutdown();
  });

  it('toggles enabled without tearing the instance down', async () => {
    const fa = new FakeUpstream('a', [{ name: 't' }]);
    const { reg } = make({ a: fa });
    await reg.applyConfig([cfg('a')]);
    const first = reg.shared('a');
    await reg.applyConfig([cfg('a', { enabled: false })]);
    expect(reg.shared('a')).toBe(first);
    expect(reg.shared('a')?.state).toBe('disabled');
    await reg.shutdown();
  });

  it('bounds startup connect concurrency', async () => {
    const slow = () => new FakeUpstream('x', [], { connectDelayMs: 20 });
    const fakes = { a: slow(), b: slow(), c: slow(), d: slow() };
    for (const [k, v] of Object.entries(fakes)) Object.assign(v, { name: k });
    const { reg } = make(fakes as unknown as Record<string, FakeUpstream>);
    const started = Date.now();
    await reg.applyConfig([cfg('a'), cfg('b'), cfg('c'), cfg('d')]);
    await vi.waitFor(() => expect(reg.list().every((s) => s.state === 'ready')).toBe(true), {
      timeout: 2000,
    });
    // 4 servers, concurrency 2, 20ms each => at least two waves.
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    await reg.shutdown();
  });

  it('bumps catalogVersion when a catalog is emitted, not only on applyConfig (Ruling P5)', async () => {
    const fa = new FakeUpstream('a', [{ name: 't' }]);
    const { reg } = make({ a: fa });
    await reg.applyConfig([cfg('a')]);
    await vi.waitFor(() => expect(reg.shared('a')?.state).toBe('ready'));
    const before = reg.catalogVersion;

    fa.setTools([{ name: 't' }, { name: 'u' }]);
    reg.shared('a')?.refresh();
    await vi.waitFor(() => expect(reg.catalogVersion).toBeGreaterThan(before));
    await reg.shutdown();
  });

  it('lease() fails closed when a per-user server has no credential resolver', async () => {
    const { reg } = make({ a: new FakeUpstream('a', []) });
    await reg.applyConfig([cfg('a', { credentialMode: 'per-user' })]);
    await expect(reg.lease('a', admin)).rejects.toBeInstanceOf(CredentialsRequiredError);
    await reg.shutdown();
  });

  it('lease() returns the shared instance for a shared-credential server', async () => {
    const { reg } = make({ a: new FakeUpstream('a', [{ name: 't' }]) });
    await reg.applyConfig([cfg('a')]);
    await expect(reg.lease('a', admin)).resolves.toBe(reg.shared('a'));
    await reg.shutdown();
  });

  it('shutdown stops every server and leaves nothing running', async () => {
    const { reg } = make({ a: new FakeUpstream('a', [{ name: 't' }]) });
    await reg.applyConfig([cfg('a')]);
    await reg.shutdown();
    expect(reg.list().every((s) => s.state === 'closed')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run --project unit packages/core/test/registry.test.ts`
Expected: FAIL — cannot resolve `../src/registry.js`.

- [ ] **Step 3: Implement**

`packages/core/src/registry.ts`:

```ts
import type { Bus, EngineEvents } from './bus.js';
import { CredentialsRequiredError } from './errors.js';
import { Semaphore } from './semaphore.js';
import type { TransportFactory } from './transport.js';
import { UpstreamServer, configHashOf, type MiniLogger } from './upstream-server.js';
import type { Principal, ServerConfig } from './types.js';

const PER_USER_IDLE_MS = Number(process.env['MCPROUTER_PER_USER_IDLE_MS'] ?? 600_000);
const TICK_MS = 30_000;

export type ServerRegistryOpts = {
  bus: Bus<EngineEvents>;
  connect: TransportFactory;
  logger: MiniLogger;
  connectConcurrency?: number;
};

type Leased = { srv: UpstreamServer; lastUsed: number };

export class ServerRegistry {
  #generation = 0;
  #catalogVersion = 0;
  readonly #shared = new Map<string, UpstreamServer>();
  readonly #perUser = new Map<string, Leased>();
  readonly #configs = new Map<string, ServerConfig>();
  readonly #sem: Semaphore;
  readonly #o: ServerRegistryOpts;
  readonly #ticker: NodeJS.Timeout;

  constructor(o: ServerRegistryOpts) {
    this.#o = o;
    this.#sem = new Semaphore(
      o.connectConcurrency ?? Number(process.env['MCPROUTER_CONNECT_CONCURRENCY'] ?? 8),
    );
    // Ruling P5: the memo in catalog.ts keys on this counter, so a listChanged
    // refresh that swapped a catalog MUST invalidate it.
    o.bus.on('server:catalog', () => {
      this.#catalogVersion += 1;
    });
    this.#ticker = setInterval(() => this.#evictIdle(), TICK_MS);
    this.#ticker.unref?.();
  }

  get generation(): number {
    return this.#generation;
  }
  get catalogVersion(): number {
    return this.#catalogVersion;
  }

  shared(name: string): UpstreamServer | undefined {
    return this.#shared.get(name);
  }

  list(): UpstreamServer[] {
    return [...this.#shared.values()];
  }

  /** Idempotent full-state diff, keyed by name + configHash. The only mutator. */
  async applyConfig(configs: ServerConfig[]): Promise<void> {
    const wanted = new Map(configs.map((c) => [c.name, c]));
    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];

    for (const [name, srv] of [...this.#shared]) {
      const cfg = wanted.get(name);
      if (cfg === undefined) {
        removed.push(name);
        this.#shared.delete(name);
        this.#configs.delete(name);
        await this.#stopChildrenOf(name);
        await srv.stop('closed');
        continue;
      }
      // An enabled-only flip is a toggle, never a restart.
      const before = this.#configs.get(name);
      if (before !== undefined && sameExceptEnabled(before, cfg)) {
        if (before.enabled !== cfg.enabled) {
          this.#configs.set(name, cfg);
          if (cfg.enabled) srv.start();
          else await srv.stop('disabled');
        }
        continue;
      }
      if (configHashOf(cfg) !== srv.configHash) {
        changed.push(name);
        this.#shared.delete(name);
        await this.#stopChildrenOf(name);
        await srv.stop('closed');
      }
    }

    for (const [name, cfg] of wanted) {
      this.#configs.set(name, cfg);
      if (this.#shared.has(name)) continue;
      if (!changed.includes(name)) added.push(name);
      const srv = this.#spawn(cfg, name);
      this.#shared.set(name, srv);
      if (cfg.enabled) srv.start();
    }

    this.#generation += 1;
    this.#catalogVersion += 1;
    this.#o.bus.emit('config:applied', {
      generation: this.#generation,
      added,
      changed,
      removed,
    });
  }

  #spawn(cfg: ServerConfig, key: string, headers?: Record<string, string>): UpstreamServer {
    return new UpstreamServer({
      config: cfg,
      key,
      bus: this.#o.bus,
      connect: this.#o.connect,
      connectSem: this.#sem,
      logger: this.#o.logger,
      ...(headers === undefined ? {} : { headers }),
    });
  }

  /**
   * Per-user instances exist for REMOTE servers only and affect execution, not
   * discovery — the catalog is always the admin-configured one. A per-user server
   * with no resolver FAILS the call; it never falls back to shared credentials,
   * because the fallback direction is the whole vulnerability (D9).
   */
  async lease(name: string, principal: Principal): Promise<UpstreamServer> {
    const cfg = this.#configs.get(name);
    const sharedSrv = this.#shared.get(name);
    if (cfg === undefined || sharedSrv === undefined) {
      throw new CredentialsRequiredError(name);
    }
    if (cfg.credentialMode !== 'per-user') return sharedSrv;
    if (principal.credentials === undefined) throw new CredentialsRequiredError(name);

    const revision = principal.credentials.revision(name);
    const key = `${name}#${principal.id}:${revision}`;
    const hit = this.#perUser.get(key);
    if (hit !== undefined) {
      hit.lastUsed = Date.now();
      return hit.srv;
    }
    const headers = await principal.credentials.resolveHeaders(name);
    const srv = this.#spawn(cfg, key, headers);
    this.#perUser.set(key, { srv, lastUsed: Date.now() });
    srv.start();
    return srv;
  }

  async #stopChildrenOf(name: string): Promise<void> {
    for (const [key, leased] of [...this.#perUser]) {
      if (key === name || key.startsWith(`${name}#`)) {
        this.#perUser.delete(key);
        await leased.srv.stop('closed');
      }
    }
  }

  #evictIdle(): void {
    const cutoff = Date.now() - PER_USER_IDLE_MS;
    for (const [key, leased] of [...this.#perUser]) {
      if (leased.lastUsed < cutoff) {
        this.#perUser.delete(key);
        void leased.srv.stop('closed');
      }
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.#ticker);
    const all = [...this.#shared.values(), ...[...this.#perUser.values()].map((l) => l.srv)];
    this.#perUser.clear();
    await Promise.all(all.map((s) => s.stop('closed')));
  }
}

function sameExceptEnabled(a: ServerConfig, b: ServerConfig): boolean {
  return configHashOf({ ...a, enabled: true }) === configHashOf({ ...b, enabled: true });
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run --project unit packages/core/test/registry.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/core/src/registry.ts packages/core/test/registry.test.ts
git commit -m "feat(core): server registry with hash-diffed applyConfig and per-user leases"
```

---

### Task 9: Catalog projection and the one predicate

**Files:**

- Create: `packages/core/src/catalog.ts`
- Test: `packages/core/test/catalog.test.ts`

**Interfaces:**

- Consumes: `ServerRegistry` (T8), `UpstreamServer` (T7), `SEP`/`ResolvedScope`/`ServerSelection` (T1), `ToolUnavailableError` (T1).
- Produces:
  - `label(sel)`, `project(sel, bare, flatten)`
  - `isExposed(srv, cfg, sel, kind, bare): boolean` — **THE** predicate, called by both list and call
  - `resolveTool(scope, reg, name): { sel; bare }` — **THE** resolver, the only construction site of `ToolUnavailableError`
  - `projectTools(scope, reg): Tool[]`, `projectPrompts(...)`, `projectResources(...)`, `projectResourceTemplates(...)`
  - `invalidateMemo()` — test hook

This task is where the mcphub CVE class becomes unrepresentable. `resolveTool` runs the **same** `isExposed` as `projectTools`, so a tool that is not listed cannot be called — not because two gates agree today, but because there is one gate.

- [ ] **Step 1: Write the failing test**

`packages/core/test/catalog.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { Bus, type EngineEvents } from '../src/bus.js';
import { ServerRegistry } from '../src/registry.js';
import { isExposed, label, project, projectTools, resolveTool } from '../src/catalog.js';
import { ToolUnavailableError } from '../src/errors.js';
import type { ResolvedScope, ServerConfig, ServerSelection } from '../src/types.js';
import { FakeUpstream, fakeFactory } from './fake-upstream.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const cfg = (name: string, over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    name,
    enabled: true,
    credentialMode: 'shared',
    type: 'stdio',
    command: 'node',
    ...over,
  }) as ServerConfig;

const sel = (serverName: string, over: Partial<ServerSelection> = {}): ServerSelection => ({
  serverName,
  tools: 'all',
  prompts: 'all',
  resources: 'all',
  ...over,
});

const scopeOf = (servers: ServerSelection[], flatten = false): ResolvedScope => ({
  key: servers.map((s) => `${s.serverName}:${String(s.tools)}`).join('|') + `:${String(flatten)}`,
  servers,
  flatten,
});

async function ready(configs: ServerConfig[], fakes: Record<string, FakeUpstream>) {
  const bus = new Bus<EngineEvents>();
  const reg = new ServerRegistry({ bus, connect: fakeFactory(fakes), logger });
  await reg.applyConfig(configs);
  await vi.waitFor(() =>
    expect(reg.list().filter((s) => s.config.enabled).every((s) => s.state === 'ready')).toBe(true),
  );
  return reg;
}

describe('naming', () => {
  it('prefixes with the server name, or the alias when set', () => {
    expect(project(sel('github'), 'create_issue', false)).toBe('github__create_issue');
    expect(project(sel('github', { alias: 'gh' }), 'create_issue', false)).toBe('gh__create_issue');
    expect(label(sel('github', { alias: 'gh' }))).toBe('gh');
  });

  it('strips the prefix entirely on a flattened single-server route', () => {
    expect(project(sel('github'), 'create_issue', true)).toBe('create_issue');
  });
});

describe('the one predicate', () => {
  it('lists tools from every selected server, namespaced', async () => {
    const reg = await ready([cfg('a'), cfg('b')], {
      a: new FakeUpstream('a', [{ name: 'one' }]),
      b: new FakeUpstream('b', [{ name: 'two' }]),
    });
    const names = projectTools(scopeOf([sel('a'), sel('b')]), reg).map((t) => t.name);
    expect(names.sort()).toEqual(['a__one', 'b__two']);
    await reg.shutdown();
  });

  it('an empty scope means an empty catalog, never everything', async () => {
    const reg = await ready([cfg('a')], { a: new FakeUpstream('a', [{ name: 'one' }]) });
    expect(projectTools(scopeOf([]), reg)).toEqual([]);
    await reg.shutdown();
  });

  it('a disabled server hides its tools from list AND call (layer 1)', async () => {
    const reg = await ready([cfg('a', { enabled: false })], {
      a: new FakeUpstream('a', [{ name: 'one' }]),
    });
    const scope = scopeOf([sel('a')]);
    expect(projectTools(scope, reg)).toEqual([]);
    expect(() => resolveTool(scope, reg, 'a__one')).toThrow(ToolUnavailableError);
    await reg.shutdown();
  });

  it('a per-tool disable hides it from list AND call (layer 2)', async () => {
    const reg = await ready([cfg('a', { tools: { one: { enabled: false } } })], {
      a: new FakeUpstream('a', [{ name: 'one' }, { name: 'two' }]),
    });
    const scope = scopeOf([sel('a')]);
    expect(projectTools(scope, reg).map((t) => t.name)).toEqual(['a__two']);
    expect(() => resolveTool(scope, reg, 'a__one')).toThrow(ToolUnavailableError);
    await reg.shutdown();
  });

  it('a scope allowlist hides the rest from list AND call (layer 3)', async () => {
    const reg = await ready([cfg('a')], {
      a: new FakeUpstream('a', [{ name: 'one' }, { name: 'two' }]),
    });
    const scope = scopeOf([sel('a', { tools: ['one'] })]);
    expect(projectTools(scope, reg).map((t) => t.name)).toEqual(['a__one']);
    expect(() => resolveTool(scope, reg, 'a__two')).toThrow(ToolUnavailableError);
    await reg.shutdown();
  });

  it('hidden, disabled and never-existed are byte-identical to the caller', async () => {
    const reg = await ready([cfg('a', { tools: { two: { enabled: false } } })], {
      a: new FakeUpstream('a', [{ name: 'one' }, { name: 'two' }]),
    });
    const scope = scopeOf([sel('a', { tools: ['one'] })]);
    const messages = ['a__two', 'a__three', 'b__one'].map((n) => {
      try {
        resolveTool(scope, reg, n);
        return 'RESOLVED';
      } catch (e) {
        return (e as Error).message.replace(n, '<name>');
      }
    });
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe('Tool not found: <name>');
    await reg.shutdown();
  });

  it('resolves through an alias and back to the bare upstream name', async () => {
    const reg = await ready([cfg('a')], { a: new FakeUpstream('a', [{ name: 'one' }]) });
    const scope = scopeOf([sel('a', { alias: 'zz' })]);
    expect(projectTools(scope, reg).map((t) => t.name)).toEqual(['zz__one']);
    expect(resolveTool(scope, reg, 'zz__one')).toMatchObject({ bare: 'one' });
    await reg.shutdown();
  });

  it('resolves a flattened name on a single-server scope', async () => {
    const reg = await ready([cfg('a')], { a: new FakeUpstream('a', [{ name: 'one' }]) });
    const scope = scopeOf([sel('a')], true);
    expect(projectTools(scope, reg).map((t) => t.name)).toEqual(['one']);
    expect(resolveTool(scope, reg, 'one').bare).toBe('one');
    await reg.shutdown();
  });

  it('isExposed is the SAME function the list path uses', async () => {
    const reg = await ready([cfg('a')], { a: new FakeUpstream('a', [{ name: 'one' }]) });
    const srv = reg.shared('a');
    expect(isExposed(srv!, srv!.config, sel('a'), 'tool', 'one')).toBe(true);
    expect(isExposed(srv!, srv!.config, sel('a', { tools: [] }), 'tool', 'one')).toBe(false);
    await reg.shutdown();
  });

  it('invalidates the memo when a refresh changes the catalog (Ruling P5)', async () => {
    const fa = new FakeUpstream('a', [{ name: 'one' }]);
    const reg = await ready([cfg('a')], { a: fa });
    const scope = scopeOf([sel('a')]);
    expect(projectTools(scope, reg).map((t) => t.name)).toEqual(['a__one']);

    fa.setTools([{ name: 'one' }, { name: 'two' }]);
    reg.shared('a')?.refresh();
    await vi.waitFor(() =>
      expect(projectTools(scope, reg).map((t) => t.name).sort()).toEqual(['a__one', 'a__two']),
    );
    await reg.shutdown();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run --project unit packages/core/test/catalog.test.ts`
Expected: FAIL — cannot resolve `../src/catalog.js`.

- [ ] **Step 3: Implement**

`packages/core/src/catalog.ts`:

```ts
import { ToolUnavailableError } from './errors.js';
import type { ServerRegistry } from './registry.js';
import type { UpstreamServer } from './upstream-server.js';
import {
  SEP,
  type Prompt,
  type Resource,
  type ResourceTemplate,
  type ResolvedScope,
  type ServerConfig,
  type ServerSelection,
  type Tool,
} from './types.js';

export function label(sel: ServerSelection): string {
  return sel.alias ?? sel.serverName;
}

export function project(sel: ServerSelection, bare: string, flatten: boolean): string {
  return flatten ? bare : `${label(sel)}${SEP}${bare}`;
}

type Kind = 'tool' | 'prompt' | 'resource';

/**
 * THE predicate. Three layers, one function, called by BOTH list and call.
 *
 * mcphub needs a filter at list time AND an independent execution gate, and
 * their CVE was the two disagreeing. Here there is nothing to disagree with.
 */
export function isExposed(
  srv: UpstreamServer,
  cfg: ServerConfig,
  sel: ServerSelection,
  kind: Kind,
  bare: string,
): boolean {
  if (!cfg.enabled) return false; // layer 1: server
  if (kind === 'tool' && cfg.tools?.[bare]?.enabled === false) return false; // layer 2: per-tool
  const allow = kind === 'tool' ? sel.tools : kind === 'prompt' ? sel.prompts : sel.resources;
  if (allow !== 'all' && !allow.includes(bare)) return false; // layer 3: scope allowlist
  const catalog = srv.catalog;
  if (catalog === undefined) return false;
  if (kind === 'tool') return catalog.tools.has(bare);
  if (kind === 'prompt') return catalog.prompts.has(bare);
  return catalog.resources.some((r) => r.uri === bare);
}

/**
 * THE resolver, and the ONLY construction site of ToolUnavailableError — which is
 * what makes hidden, disabled and never-existed indistinguishable from outside.
 */
export function resolveTool(
  scope: ResolvedScope,
  reg: ServerRegistry,
  name: string,
): { sel: ServerSelection; bare: string } {
  for (const sel of scope.servers) {
    const prefix = `${label(sel)}${SEP}`;
    const bare = scope.flatten ? name : name.startsWith(prefix) ? name.slice(prefix.length) : null;
    if (bare === null) continue;
    const srv = reg.shared(sel.serverName);
    if (srv !== undefined && isExposed(srv, srv.config, sel, 'tool', bare)) return { sel, bare };
  }
  throw new ToolUnavailableError(name);
}

// ---- projection, memoized on scope.key + catalogVersion ----------------------

type MemoEntry = {
  tools: Tool[];
  prompts: Prompt[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
};
const memo = new Map<string, MemoEntry>();

export function invalidateMemo(): void {
  memo.clear();
}

function build(scope: ResolvedScope, reg: ServerRegistry): MemoEntry {
  const out: MemoEntry = { tools: [], prompts: [], resources: [], resourceTemplates: [] };
  for (const sel of scope.servers) {
    const srv = reg.shared(sel.serverName);
    const catalog = srv?.catalog;
    if (srv === undefined || catalog === undefined) continue;

    for (const [bare, tool] of catalog.tools) {
      if (!isExposed(srv, srv.config, sel, 'tool', bare)) continue;
      out.tools.push({ ...tool, name: project(sel, bare, scope.flatten) });
    }
    for (const [bare, prompt] of catalog.prompts) {
      if (!isExposed(srv, srv.config, sel, 'prompt', bare)) continue;
      out.prompts.push({ ...prompt, name: project(sel, bare, scope.flatten) });
    }
    for (const resource of catalog.resources) {
      if (!isExposed(srv, srv.config, sel, 'resource', resource.uri)) continue;
      out.resources.push(resource);
    }
    out.resourceTemplates.push(...catalog.resourceTemplates);
  }
  return out;
}

function entry(scope: ResolvedScope, reg: ServerRegistry): MemoEntry {
  const key = `${scope.key}:${reg.catalogVersion}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const built = build(scope, reg);
  // One entry per live scope: drop this scope's older generations.
  for (const k of memo.keys()) if (k.startsWith(`${scope.key}:`)) memo.delete(k);
  memo.set(key, built);
  return built;
}

export function projectTools(scope: ResolvedScope, reg: ServerRegistry): Tool[] {
  return entry(scope, reg).tools;
}
export function projectPrompts(scope: ResolvedScope, reg: ServerRegistry): Prompt[] {
  return entry(scope, reg).prompts;
}
export function projectResources(scope: ResolvedScope, reg: ServerRegistry): Resource[] {
  return entry(scope, reg).resources;
}
export function projectResourceTemplates(
  scope: ResolvedScope,
  reg: ServerRegistry,
): ResourceTemplate[] {
  return entry(scope, reg).resourceTemplates;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run --project unit packages/core/test/catalog.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/core/src/catalog.ts packages/core/test/catalog.test.ts
git commit -m "feat(core): catalog projection and one predicate shared by list and call"
```

---

### Task 10: The call path and the §11.4 seam

**Files:**

- Create: `packages/core/src/call.ts`
- Test: `packages/core/test/call.test.ts`

**Interfaces:**

- Consumes: `resolveTool` (T9), `ServerRegistry` (T8), errors (T1).
- Produces:
  - `type ToolDecision = { sel: ServerSelection; bare: string; server: string }`
  - `function resolveToolDecision(scope, reg, name): ToolDecision`
  - `function callResolved(deps, decision, req): Promise<CallToolResult>`
  - `function callTool(deps, req): Promise<CallToolResult>` — **exactly** `callResolved(deps, resolveToolDecision(...), req)`
  - `getPrompt`, `readResource`

**This task IS the §11.4 guardrail seam, which §13 sizes at +0.0w precisely because it is a shape imposed on code being written anyway.** P2 inserts the policy gate between `resolveToolDecision` and `callResolved` without touching either. Write it split from the start; merging it later is the expensive direction.

**D11 — the retry gate.** A failed call is retried **exactly once**, and **only** when we can prove the request never reached the upstream. A delivered call that returned an error — any JSON-RPC error, any `isError: true` — is **never** retried. mcphub retries on HTTP 4xx, which is a *response*: the tool already ran, so their retry can double-execute a write.

- [ ] **Step 1: Write the failing test**

`packages/core/test/call.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { Bus, type EngineEvents } from '../src/bus.js';
import { ServerRegistry } from '../src/registry.js';
import { callTool, resolveToolDecision } from '../src/call.js';
import { PayloadTooLargeError, ToolUnavailableError } from '../src/errors.js';
import type { Principal, ResolvedScope, ServerConfig } from '../src/types.js';
import { FakeUpstream, fakeFactory } from './fake-upstream.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const principal: Principal = { id: 'u1', isAdmin: false };

const cfg = (name: string, over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    name,
    enabled: true,
    credentialMode: 'shared',
    type: 'stdio',
    command: 'node',
    ...over,
  }) as ServerConfig;

const scope: ResolvedScope = {
  key: 'k',
  servers: [{ serverName: 'a', tools: 'all', prompts: 'all', resources: 'all' }],
  flatten: false,
};

async function up(fake: FakeUpstream, c = cfg('a')) {
  const bus = new Bus<EngineEvents>();
  const reg = new ServerRegistry({ bus, connect: fakeFactory({ a: fake }), logger });
  await reg.applyConfig([c]);
  await vi.waitFor(() => expect(reg.shared('a')?.state).toBe('ready'));
  return { reg, bus, deps: { reg, bus, logger } };
}

describe('call path', () => {
  it('calls the tool and returns the upstream result', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo', handler: (x) => `got ${String(x['v'])}` }]);
    const { reg, deps } = await up(fake);
    const res = await callTool(deps, { scope, principal, name: 'a__echo', args: { v: 7 } });
    expect(JSON.stringify(res)).toContain('got 7');
    await reg.shutdown();
  });

  it('callTool is exactly resolve + callResolved (the §11.4 seam)', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg } = await up(fake);
    const decision = resolveToolDecision(scope, reg, 'a__echo');
    expect(decision).toMatchObject({ bare: 'echo', server: 'a' });
    await reg.shutdown();
  });

  it('refuses a tool the scope does not expose, with the shared message', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, deps } = await up(fake, cfg('a', { tools: { echo: { enabled: false } } }));
    await expect(
      callTool(deps, { scope, principal, name: 'a__echo', args: {} }),
    ).rejects.toBeInstanceOf(ToolUnavailableError);
    await reg.shutdown();
  });

  it('rejects arguments over the size cap before touching the upstream', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, deps } = await up(fake);
    const huge = { blob: 'x'.repeat(1_100_000) };
    await expect(
      callTool(deps, { scope, principal, name: 'a__echo', args: huge }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    await reg.shutdown();
  });

  it('NEVER retries a call that was delivered and returned an error (D11)', async () => {
    let calls = 0;
    const fake = new FakeUpstream('a', [
      {
        name: 'write',
        handler: () => {
          calls += 1;
          throw new Error('upstream says no');
        },
      },
    ]);
    const { reg, deps } = await up(fake);
    await callTool(deps, { scope, principal, name: 'a__write', args: {} }).catch(() => undefined);
    expect(calls).toBe(1); // the write must not have run twice
    await reg.shutdown();
  });

  it('retries once when the transport proves the request never left (D11)', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, deps } = await up(fake);
    const srv = reg.shared('a')!;
    const spy = vi.spyOn(srv, 'callTool');
    spy.mockRejectedValueOnce(Object.assign(new Error('not connected'), { code: 'ENOTCONN' }));

    const res = await callTool(deps, { scope, principal, name: 'a__echo', args: {} });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(res).toBeDefined();
    await reg.shutdown();
  });

  it('emits call:start and call:end around every call', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, bus, deps } = await up(fake);
    const events: string[] = [];
    bus.on('call:start', () => events.push('start'));
    bus.on('call:end', () => events.push('end'));
    await callTool(deps, { scope, principal, name: 'a__echo', args: {} });
    expect(events).toEqual(['start', 'end']);
    await reg.shutdown();
  });

  it('emits call:end with ok:false when the call throws', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, bus, deps } = await up(fake);
    const ends: boolean[] = [];
    bus.on('call:end', (e) => ends.push(e.ok));
    await callTool(deps, { scope, principal, name: 'a__nope', args: {} }).catch(() => undefined);
    expect(ends).toEqual([false]);
    await reg.shutdown();
  });

  it('strips a resolved credential value out of a thrown error', async () => {
    const fake = new FakeUpstream('a', [{ name: 'echo' }]);
    const { reg, deps } = await up(fake);
    const srv = reg.shared('a')!;
    vi.spyOn(srv, 'callTool').mockRejectedValue(new Error('rejected token ghp_LEAK'));
    const err = await callTool(deps, {
      scope,
      principal,
      name: 'a__echo',
      args: {},
      secrets: ['ghp_LEAK'],
    }).catch((e: Error) => e);
    expect(err.message).not.toContain('ghp_LEAK');
    await reg.shutdown();
  });

  it('propagates an AbortSignal as a cancellation', async () => {
    const fake = new FakeUpstream('a', [
      { name: 'slow', handler: async () => new Promise<string>(() => {}) },
    ]);
    const { reg, deps } = await up(fake);
    const ac = new AbortController();
    const p = callTool(deps, {
      scope,
      principal,
      name: 'a__slow',
      args: {},
      signal: ac.signal,
    });
    ac.abort();
    await expect(p).rejects.toBeDefined();
    await reg.shutdown();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run --project unit packages/core/test/call.test.ts`
Expected: FAIL — cannot resolve `../src/call.js`.

- [ ] **Step 3: Implement**

`packages/core/src/call.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Bus, EngineEvents } from './bus.js';
import { resolveTool } from './catalog.js';
import { PayloadTooLargeError, redact } from './errors.js';
import type { ServerRegistry } from './registry.js';
import type { MiniLogger } from './upstream-server.js';
import type { Principal, ResolvedScope, ServerSelection } from './types.js';

const MAX_ARG_BYTES = Number(process.env['MCPROUTER_MAX_ARG_BYTES'] ?? 1_048_576);

export type CallDeps = { reg: ServerRegistry; bus: Bus<EngineEvents>; logger: MiniLogger };

export type ToolDecision = { sel: ServerSelection; bare: string; server: string };

export type CallToolReq = {
  scope: ResolvedScope;
  principal: Principal;
  /** Downstream name: prefixed, aliased or flattened. */
  name: string;
  args: Record<string, unknown>;
  signal?: AbortSignal | undefined;
  onProgress?: ((p: { progress: number; total?: number; message?: string }) => void) | undefined;
  deadlineMs?: number | undefined;
  secrets?: readonly string[] | undefined;
};

/**
 * §11.4 seam, half one: WHICH tool, and may this scope reach it. Pure lookup —
 * no I/O. P2 inserts the policy gate between this and `callResolved`; neither
 * function changes when it does.
 */
export function resolveToolDecision(
  scope: ResolvedScope,
  reg: ServerRegistry,
  name: string,
): ToolDecision {
  const { sel, bare } = resolveTool(scope, reg, name);
  return { sel, bare, server: sel.serverName };
}

/** True only when we can prove the request never reached the upstream (D11). */
function neverDelivered(err: unknown): boolean {
  const e = err as { code?: unknown; message?: string };
  const code = String(e.code ?? '');
  if (['ENOTCONN', 'ECONNRESET', 'EPIPE', 'ECONNREFUSED'].includes(code)) return true;
  return /not connected|connection closed|transport closed/i.test(e.message ?? '');
}

/**
 * §11.4 seam, half two: execute an already-authorized decision.
 *
 * The retry is gated on "did the request arrive", never on a status code. A
 * delivered call that failed has already run its side effect; retrying it is a
 * data-corruption bug wearing a resilience costume.
 */
export async function callResolved(
  deps: CallDeps,
  decision: ToolDecision,
  req: CallToolReq,
): Promise<unknown> {
  const callId = randomUUID();
  const started = Date.now();
  const size = Buffer.byteLength(JSON.stringify(req.args ?? {}), 'utf8');
  if (size > MAX_ARG_BYTES) {
    throw new PayloadTooLargeError(`Arguments too large: ${size} bytes (max ${MAX_ARG_BYTES})`);
  }

  deps.bus.emit('call:start', {
    callId,
    server: decision.server,
    kind: 'tool',
    target: decision.bare,
    principalId: req.principal.id,
    scopeKey: req.scope.key,
    args: req.args,
  });

  const srv = await deps.reg.lease(decision.server, req.principal);
  await srv.ensureReady(req.deadlineMs);

  const opts = {
    ...(req.signal === undefined ? {} : { signal: req.signal }),
    ...(req.onProgress === undefined ? {} : { onProgress: req.onProgress }),
    ...(req.deadlineMs === undefined ? {} : { deadlineMs: req.deadlineMs }),
    ...(req.secrets === undefined ? {} : { secrets: req.secrets }),
  };

  try {
    let result: unknown;
    try {
      result = await srv.callTool(decision.bare, req.args, opts);
    } catch (err) {
      if (!neverDelivered(err)) throw err;
      deps.logger.debug({ evt: 'call.retry', callId, server: decision.server });
      await srv.ensureReady(req.deadlineMs);
      result = await srv.callTool(decision.bare, req.args, opts);
    }
    const isError = (result as { isError?: boolean } | undefined)?.isError === true;
    deps.bus.emit('call:end', {
      callId,
      ok: true,
      isError,
      durationMs: Date.now() - started,
      result,
    });
    return result;
  } catch (err) {
    const e = redact(err instanceof Error ? err : new Error(String(err)), req.secrets ?? []);
    deps.bus.emit('call:end', {
      callId,
      ok: false,
      isError: true,
      durationMs: Date.now() - started,
      errorCode: String((e as { code?: string }).code ?? 'ERROR'),
    });
    throw e;
  }
}

/** The composition. Nothing else may call an upstream tool. */
export async function callTool(deps: CallDeps, req: CallToolReq): Promise<unknown> {
  let decision: ToolDecision;
  try {
    decision = resolveToolDecision(req.scope, deps.reg, req.name);
  } catch (err) {
    deps.bus.emit('call:end', {
      callId: randomUUID(),
      ok: false,
      isError: true,
      durationMs: 0,
      errorCode: 'TOOL_UNAVAILABLE',
    });
    throw err;
  }
  return callResolved(deps, decision, req);
}

export async function getPrompt(
  deps: CallDeps,
  req: CallToolReq & { args: Record<string, unknown> },
): Promise<unknown> {
  const { sel, bare } = resolveTool(req.scope, deps.reg, req.name);
  const srv = await deps.reg.lease(sel.serverName, req.principal);
  await srv.ensureReady(req.deadlineMs);
  try {
    return await srv.getPrompt(bare, req.args, {});
  } catch (err) {
    throw redact(err instanceof Error ? err : new Error(String(err)), req.secrets ?? []);
  }
}

export async function readResource(
  deps: CallDeps,
  req: { scope: ResolvedScope; principal: Principal; uri: string; server: string },
): Promise<unknown> {
  const srv = await deps.reg.lease(req.server, req.principal);
  await srv.ensureReady();
  return srv.readResource(req.uri, {});
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run --project unit packages/core/test/call.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/core/src/call.ts packages/core/test/call.test.ts
git commit -m "feat(core): split call path into resolve and execute, retry only undelivered calls

The retry gate is 'did the request arrive', never a status code. A delivered
call that returned an error has already run its side effect, so retrying it can
double-execute a write."
```

---

### Task 11: The Engine facade

**Files:**

- Create: `packages/core/src/engine.ts`
- Modify: `packages/core/src/index.ts` (re-export the public surface)
- Test: `packages/core/test/engine.test.ts`

**Interfaces:**

- Consumes: everything above.
- Produces: `class Engine` — the ONLY object `packages/server` holds — plus the public type and error re-exports from `@mcprouter/core`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/engine.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/engine.js';
import type { Principal, ResolvedScope, ServerConfig } from '../src/types.js';
import { FakeUpstream, fakeFactory } from './fake-upstream.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const principal: Principal = { id: 'u1', isAdmin: true };

const cfg = (name: string): ServerConfig => ({
  name,
  enabled: true,
  credentialMode: 'shared',
  type: 'stdio',
  command: 'node',
});

const scopeOf = (names: string[], flatten = false): ResolvedScope => ({
  key: `${names.join(',')}:${String(flatten)}`,
  servers: names.map((serverName) => ({
    serverName,
    tools: 'all' as const,
    prompts: 'all' as const,
    resources: 'all' as const,
  })),
  flatten,
});

describe('Engine', () => {
  it('aggregates two upstreams into one namespaced catalog and calls through it', async () => {
    const fakes = {
      fs: new FakeUpstream('fs', [{ name: 'read_file', handler: () => 'contents' }]),
      gh: new FakeUpstream('gh', [{ name: 'create_issue' }]),
    };
    const engine = new Engine({ logger, connect: fakeFactory(fakes) });
    await engine.applyConfig([cfg('fs'), cfg('gh')]);
    await vi.waitFor(() => expect(engine.status().every((s) => s.state === 'ready')).toBe(true));

    const scope = scopeOf(['fs', 'gh']);
    const tools = await engine.listTools(scope, principal);
    expect(tools.map((t) => t.name).sort()).toEqual(['fs__read_file', 'gh__create_issue']);

    const res = await engine.callTool({
      scope,
      principal,
      name: 'fs__read_file',
      args: {},
    });
    expect(JSON.stringify(res)).toContain('contents');
    await engine.shutdown();
  });

  it('status() is synchronous and needs no upstream I/O', async () => {
    const engine = new Engine({
      logger,
      connect: fakeFactory({ fs: new FakeUpstream('fs', [{ name: 't' }]) }),
    });
    await engine.applyConfig([cfg('fs')]);
    const status = engine.status();
    expect(status).toHaveLength(1);
    expect(status[0]?.name).toBe('fs');
    await engine.shutdown();
  });

  it('exposes the per-server catalog for later context-cost work', async () => {
    const engine = new Engine({
      logger,
      connect: fakeFactory({ fs: new FakeUpstream('fs', [{ name: 't' }]) }),
    });
    await engine.applyConfig([cfg('fs')]);
    await vi.waitFor(() => expect(engine.catalog('fs')?.tools.size).toBe(1));
    expect(engine.catalog('nope')).toBeUndefined();
    await engine.shutdown();
  });

  it('shutdown is idempotent', async () => {
    const engine = new Engine({
      logger,
      connect: fakeFactory({ fs: new FakeUpstream('fs', []) }),
    });
    await engine.applyConfig([cfg('fs')]);
    await engine.shutdown();
    await expect(engine.shutdown()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run --project unit packages/core/test/engine.test.ts`
Expected: FAIL — cannot resolve `../src/engine.js`.

- [ ] **Step 3: Implement**

`packages/core/src/engine.ts`:

```ts
import { Bus, type EngineEvents } from './bus.js';
import {
  callResolved,
  callTool as callToolImpl,
  getPrompt as getPromptImpl,
  readResource as readResourceImpl,
  resolveToolDecision,
  type CallDeps,
  type CallToolReq,
  type ToolDecision,
} from './call.js';
import {
  projectPrompts,
  projectResourceTemplates,
  projectResources,
  projectTools,
} from './catalog.js';
import { ServerRegistry } from './registry.js';
import { createTransport, type TransportFactory } from './transport.js';
import type { MiniLogger } from './upstream-server.js';
import type {
  Principal,
  Prompt,
  ResolvedScope,
  Resource,
  ResourceTemplate,
  ServerCatalog,
  ServerConfig,
  ServerStatus,
  Tool,
} from './types.js';

export type EngineOptions = {
  logger: MiniLogger;
  /** Default: the real factory. THE TEST SEAM. */
  connect?: TransportFactory;
  connectConcurrency?: number;
};

/** The only object packages/server holds. Core does no authz and no config storage. */
export class Engine {
  readonly events: Bus<EngineEvents>;
  readonly #reg: ServerRegistry;
  readonly #deps: CallDeps;
  #down = false;

  constructor(opts: EngineOptions) {
    this.events = new Bus<EngineEvents>((err) =>
      opts.logger.warn({ evt: 'bus.listener_threw', err }),
    );
    this.#reg = new ServerRegistry({
      bus: this.events,
      connect: opts.connect ?? createTransport,
      logger: opts.logger,
      ...(opts.connectConcurrency === undefined
        ? {}
        : { connectConcurrency: opts.connectConcurrency }),
    });
    this.#deps = { reg: this.#reg, bus: this.events, logger: opts.logger };
  }

  /** Idempotent full-state diff. Safe to call on every config write. */
  async applyConfig(configs: ServerConfig[]): Promise<void> {
    await this.#reg.applyConfig(configs);
  }

  listTools(scope: ResolvedScope, _principal: Principal): Promise<Tool[]> {
    return Promise.resolve(projectTools(scope, this.#reg));
  }
  listPrompts(scope: ResolvedScope, _principal: Principal): Promise<Prompt[]> {
    return Promise.resolve(projectPrompts(scope, this.#reg));
  }
  listResources(scope: ResolvedScope, _principal: Principal): Promise<Resource[]> {
    return Promise.resolve(projectResources(scope, this.#reg));
  }
  listResourceTemplates(scope: ResolvedScope, _principal: Principal): Promise<ResourceTemplate[]> {
    return Promise.resolve(projectResourceTemplates(scope, this.#reg));
  }

  callTool(req: CallToolReq): Promise<unknown> {
    return callToolImpl(this.#deps, req);
  }

  /** §11.4: exposed so P2's policy gate can sit between resolve and execute. */
  resolve(scope: ResolvedScope, name: string): ToolDecision {
    return resolveToolDecision(scope, this.#reg, name);
  }
  callResolved(decision: ToolDecision, req: CallToolReq): Promise<unknown> {
    return callResolved(this.#deps, decision, req);
  }

  getPrompt(req: CallToolReq): Promise<unknown> {
    return getPromptImpl(this.#deps, req);
  }
  readResource(req: {
    scope: ResolvedScope;
    principal: Principal;
    uri: string;
    server: string;
  }): Promise<unknown> {
    return readResourceImpl(this.#deps, req);
  }

  /** Everything a dashboard needs. Cheap, synchronous, no upstream I/O. */
  status(): ServerStatus[] {
    return this.#reg.list().map((s) => ({
      name: s.name,
      state: s.state,
      stale: s.stale,
      toolCount: s.catalog?.tools.size ?? 0,
      ...(s.lastError === undefined ? {} : { lastError: s.lastError.message }),
      attempt: s.attempt,
      stderrTail: s.stderrTail,
    }));
  }

  catalog(serverName: string): ServerCatalog | undefined {
    return this.#reg.shared(serverName)?.catalog;
  }

  /** Operator action: force a reconnect and reset the attempt counter. */
  async reload(serverName: string): Promise<void> {
    const srv = this.#reg.shared(serverName);
    if (srv === undefined) return;
    await srv.stop('idle');
    srv.start();
  }

  async shutdown(): Promise<void> {
    if (this.#down) return;
    this.#down = true;
    await this.#reg.shutdown();
  }
}
```

- [ ] **Step 4: Re-export the public surface**

Append to `packages/core/src/index.ts`:

```ts
export { Engine, type EngineOptions } from './engine.js';
export { Bus, type EngineEvents } from './bus.js';
export {
  callResolved,
  callTool,
  resolveToolDecision,
  type CallDeps,
  type CallToolReq,
  type ToolDecision,
} from './call.js';
export {
  isExposed,
  label,
  project,
  projectTools,
  resolveTool,
  type ServerRegistry as CatalogRegistry,
} from './catalog.js';
export { createTransport, type TransportCtx, type TransportFactory } from './transport.js';
export { assertSafeUrl, guardedFetch, isBlockedIp } from './ssrf.js';
export {
  CredentialsRequiredError,
  PayloadTooLargeError,
  ToolUnavailableError,
  UnsafeUrlError,
  UpstreamAuthRequiredError,
  UpstreamBusyError,
  UpstreamUnavailableError,
  redact,
} from './errors.js';
export { SEP } from './types.js';
export type {
  CallOpts,
  CredentialResolver,
  Principal,
  Prompt,
  ResolvedScope,
  Resource,
  ResourceTemplate,
  ServerCatalog,
  ServerConfig,
  ServerSelection,
  ServerStatus,
  Tool,
} from './types.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run --project unit packages/core/test/engine.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Verify the architectural constraints still hold**

```bash
grep -rn "session" packages/core/src && echo "FAIL: the string 'session' is in core" || echo "ok: no 'session' in core"
node -e "try{require.resolve('hono/package.json',{paths:['packages/core']});console.log('FAIL: hono reachable')}catch(e){console.log('ok: hono '+e.code)}"
```

Expected: both print `ok:`.

- [ ] **Step 7: Commit**

```bash
pnpm build && pnpm lint && pnpm test
git add packages/core/src/engine.ts packages/core/src/index.ts packages/core/test/engine.test.ts
git commit -m "feat(core): Engine facade composing registry, catalog and call"
```

---

### Task 12: The one real child process

**Files:**

- Create: `packages/core/test/stdio.itest.ts`

**Interfaces:**

- Consumes: `Engine` (T11), `createTransport` (T5) — the REAL one, not the fake.
- Produces: nothing. This is the only test that spawns a process, and it exists to cover what `InMemoryTransport` structurally cannot: PATH augmentation, stderr capture, and leaving no orphan behind.

> Named `.itest.ts` so it runs in the `integration` project, next to the P0 migration test. The unit project stays free of child processes.

- [ ] **Step 1: Write the test**

`packages/core/test/stdio.itest.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { Engine } from '../src/engine.js';
import type { Principal, ResolvedScope, ServerConfig } from '../src/types.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const principal: Principal = { id: 'u1', isAdmin: true };

/** A minimal, dependency-free MCP server over stdio, written inline. */
const UPSTREAM = `
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
process.stderr.write('upstream starting\\n');
const server = new McpServer({ name: 'inline', version: '0.0.0' });
server.registerTool('ping', { description: 'ping', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));
server.connect(new StdioServerTransport());
`;

const cfg: ServerConfig = {
  name: 'inline',
  enabled: true,
  credentialMode: 'shared',
  type: 'stdio',
  command: process.execPath,
  args: ['-e', UPSTREAM],
};

const scope: ResolvedScope = {
  key: 'inline',
  servers: [{ serverName: 'inline', tools: 'all', prompts: 'all', resources: 'all' }],
  flatten: true,
};

function childPids(): string[] {
  const out = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((l) => l.includes('upstream starting') || l.includes("McpServer({ name: 'inline'"))
    .map((l) => l.trim().split(/\s+/)[0] ?? '');
}

describe('stdio upstream (real child process)', () => {
  it('spawns, discovers, calls, captures stderr, and leaves no orphan', async () => {
    const engine = new Engine({ logger });
    await engine.applyConfig([cfg]);

    await expect
      .poll(async () => (await engine.listTools(scope, principal)).length, { timeout: 30_000 })
      .toBe(1);

    const tools = await engine.listTools(scope, principal);
    expect(tools[0]?.name).toBe('ping'); // flattened: no prefix

    const res = await engine.callTool({ scope, principal, name: 'ping', args: {} });
    expect(JSON.stringify(res)).toContain('pong');

    expect(engine.status()[0]?.stderrTail.join('\n')).toContain('upstream starting');

    await engine.shutdown();
    await new Promise((r) => setTimeout(r, 500));
    expect(childPids().filter((p) => p.length > 0)).toEqual([]);
  }, 60_000);
});
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run --project integration packages/core/test/stdio.itest.ts`
Expected: PASS, 1 test.

> `vitest.config.ts`'s integration project includes `packages/*/src/**/*.itest.ts`. **Add `packages/*/test/**/*.itest.ts`** the same way Task 6 extended the unit project, and confirm the run reports 1 test rather than "No test files found".
>
> If the orphan assertion is flaky on this machine's `ps` output, do not delete the assertion and do not add a retry — `retry: 0` is a global constraint. Narrow the match instead (a unique marker string in the inline source) so it identifies exactly this child.

- [ ] **Step 3: Full verification and commit**

```bash
pnpm build && pnpm lint && pnpm test && pnpm vitest run --coverage && pnpm db:check
```

Expected: every command exits 0, `pnpm lint` with zero warnings, and coverage above the P0 gates (lines 70 / functions 70 / branches 60).

```bash
git add packages/core/test/stdio.itest.ts vitest.config.ts
git commit -m "test(core): real stdio child process covering PATH, stderr and orphan cleanup"
```

---

## P1a Acceptance

All five must hold before P1b starts:

1. `pnpm build && pnpm lint && pnpm test` green from a clean clone, `pnpm lint` with **zero warnings**.
2. `pnpm vitest run --coverage` passes the P0 gates unchanged.
3. `packages/core` still cannot resolve `hono` (`MODULE_NOT_FOUND`) and contains no occurrence of the string `session`, **with the SDK installed**.
4. The engine aggregates two fake upstreams into one namespaced catalog and calls a tool through it.
5. One real child process spawns, answers, and leaves no orphan after `shutdown()`.

## Self-Review

**Spec coverage.** Every §13 P1 item that belongs to core has a task:

| §13 P1 item | Task |
| ----------- | ---- |
| core upstream registry, generation counter | T8 |
| `connectStillWanted` guard | T7 (`#epoch`, the identity guard) |
| stdio + streamable-http + sse upstream | T5, T12 |
| SSRF guard validating every redirect | T4 |
| tool cache namespace `<server>__<tool>` at cache time | T7 (overrides at cache time), T9 (projection) |
| §11.4 `resolveTool` + `callResolved` split | T10 |

Deferred to P1b/P1c by design, not omission: `POST /mcp` and the 405 (P1c, `packages/server`), better-auth + apiKey (P1c), the `servers`/`secrets` tables and `{"$secret":…}` resolution (P1b), `mcprouter servers add` (P1c).

**Known gaps, written down rather than assumed away:**

- **DNS rebinding** is not closed by `assertSafeUrl` — Task 4 says so and assigns it to P7 hardening.
- **OAuth upstream** (`authProviderFor`, the `authRequired` → `authResolved` path) is modelled in the state machine but has no driver in P1a. The state exists so P1c/P5.5 can wire it without touching the table.
- The **fake upstream's shape differs from the design sketch** (a class with knobs plus `fakeFactory`, rather than one `fakeUpstream(spec)` returning a bag). Same capabilities, same seam; the plan is internally consistent and the design's sketch was illustrative.

**Type consistency.** `ToolDecision`, `CallDeps`, `CallToolReq`, `MiniLogger`, `ServerCatalog`, `ResolvedScope` and `ServerSelection` are each defined once and referenced by that exact name in every later task. `UpstreamServer.callTool` returns `unknown` rather than the SDK's `CallToolResult`, and `Engine.callTool` does too — narrowing it is P1c's job, where the MCP surface re-validates against the protocol types anyway.

**Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step carries the code.
