import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Engine, ToolUnavailableError, type Principal, type ResolvedScope } from '@mcprouter/core';
import { FakeUpstream, fakeFactory } from '../../../core/test/fake-upstream.js';
import { ALLOW_ALL_GATE } from '../gate.js';
import { capResult, handleMcp, type CallRecord, type McpCall } from './legacy.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const principal: Principal = { id: 'u1', isAdmin: false };
const scope: ResolvedScope = {
  key: 'fs',
  servers: [{ serverName: 'fs', tools: 'all', prompts: 'all', resources: 'all' }],
  flatten: false,
};
let engine: Engine;

beforeAll(async () => {
  const fs = new FakeUpstream(
    'fs',
    [
      { name: 'echo', handler: (a) => `echo:${String(a['text'])}` },
      {
        name: 'boom',
        handler: () => {
          throw new Error('upstream exploded');
        },
      },
      { name: 'slow', handler: () => new Promise((r) => setTimeout(() => r('late'), 2_000)) },
      { name: 'big', handler: () => 'y'.repeat(5_000) },
    ],
    {
      prompts: [
        { name: 'greet', handler: (a) => `hi ${a['who']}` },
        {
          name: 'broken',
          handler: () => {
            throw new Error('prompt exploded');
          },
        },
      ],
      resources: [{ uri: 'mem://readme', handler: () => 'readme body' }],
    },
  );
  engine = new Engine({ logger, connect: fakeFactory({ fs }) });
  await engine.applyConfig([
    { name: 'fs', enabled: true, credentialMode: 'shared', type: 'stdio', command: 'x' },
  ]);
  await vi.waitFor(() => expect(engine.status()[0]?.state).toBe('ready'));
});

afterAll(() => engine.shutdown());

const records: CallRecord[] = [];
const call = (timeoutMs = 5_000): McpCall => ({
  engine,
  scope,
  principal,
  timeoutMs,
  resultMaxBytes: 1_048_576,
  gate: ALLOW_ALL_GATE,
  audit: (r) => records.push(r),
});
const handleMcpCap = (resultMaxBytes: number): McpCall => ({ ...call(), resultMaxBytes });

async function client(timeoutMs?: number): Promise<Client> {
  const c = new Client({ name: 'test', version: '0.0.0' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL('http://hub.test/mcp'), {
      fetch: (url, init) => handleMcp(new Request(url, init), call(timeoutMs)),
    }),
  );
  return c;
}

describe('handleMcp', () => {
  it('serves initialize, initialized and tools/list as separate requests', async () => {
    const c = await client();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'fs__big',
      'fs__boom',
      'fs__echo',
      'fs__slow',
    ]);
    await c.close();
  });

  it('calls a tool through the engine', async () => {
    const c = await client();
    const res = await c.callTool({ name: 'fs__echo', arguments: { text: 'hi' } });
    expect(JSON.stringify(res.content)).toContain('echo:hi');
    await c.close();
  });

  it('an unknown tool is a protocol error with the one not-found message', async () => {
    const c = await client();
    await expect(c.callTool({ name: 'fs__nope', arguments: {} })).rejects.toThrow(
      /Tool not found: fs__nope/,
    );
    await c.close();
  });

  it('an upstream failure is a tool result with isError, not a transport failure', async () => {
    const c = await client();
    const res = await c.callTool({ name: 'fs__boom', arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('upstream exploded');
    await c.close();
  });

  it('a call past the deadline comes back as an error result', async () => {
    const c = await client(100);
    const res = await c.callTool({ name: 'fs__slow', arguments: {} });
    expect(res.isError).toBe(true);
    await c.close();
  });

  it('serves prompts and resources', async () => {
    const c = await client();
    const { prompts } = await c.listPrompts();
    const greet = prompts.find((p) => p.name.endsWith('greet'));
    expect(greet).toBeDefined();
    const got = await c.getPrompt({ name: greet?.name ?? '', arguments: { who: 'bob' } });
    expect(JSON.stringify(got.messages)).toContain('hi bob');

    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri)).toEqual(['mem://readme']);
    const read = await c.readResource({ uri: 'mem://readme' });
    expect(JSON.stringify(read.contents)).toContain('readme body');
    await c.close();
  });

  it('an unknown prompt or resource is a protocol error, and templates list', async () => {
    const c = await client();
    await expect(c.getPrompt({ name: 'fs__nope' })).rejects.toThrow();
    await expect(c.readResource({ uri: 'mem://nope' })).rejects.toThrow();
    // Any other failure passes through as a protocol error too, never as a hidden success.
    await expect(c.getPrompt({ name: 'fs__broken' })).rejects.toThrow(/prompt exploded/);
    expect((await c.listResourceTemplates()).resourceTemplates).toEqual([]);
    await c.close();
  });

  it('answers with buffered JSON, no session id, and X-Accel-Buffering: no', async () => {
    const res = await handleMcp(
      new Request('http://hub.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 't', version: '0' },
          },
        }),
      }),
      call(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(res.headers.get('x-accel-buffering')).toBe('no');
  });
});

describe('audit records', () => {
  it('one per call: server, bare item, outcome, argument KEY NAMES and size — never values', async () => {
    records.length = 0;
    const c = await client();
    await c.callTool({ name: 'fs__echo', arguments: { text: 'secret-value' } });
    await c.callTool({ name: 'fs__boom', arguments: {} });
    await expect(c.callTool({ name: 'fs__nope', arguments: {} })).rejects.toThrow();
    await c.close();
    expect(records.map((r) => [r.server, r.item, r.outcome])).toEqual([
      ['fs', 'echo', 'ok'],
      ['fs', 'boom', 'error'],
      [null, 'fs__nope', 'not_found'],
    ]);
    expect(records[0]?.inputKeys).toEqual(['text']);
    expect(records[0]?.inputBytes).toBe(Buffer.byteLength('{"text":"secret-value"}'));
    expect(JSON.stringify(records)).not.toContain('secret-value');
    // metadata mode (§8): the error's KIND, never its text — upstreams echo argument values.
    expect(records[1]?.error).toMatch(/Error/);
    expect(records[1]?.error).not.toContain('upstream exploded');
  });

  it('a call past the deadline is recorded as a timeout', async () => {
    records.length = 0;
    const c = await client(100);
    await c.callTool({ name: 'fs__slow', arguments: {} });
    await c.close();
    expect(records[0]?.outcome).toBe('timeout');
  });
});

describe('races and odd inputs (stub engine)', () => {
  // Only the two methods tools/call touches; everything else is never reached.
  const stub = (callResolved: () => Promise<unknown>, resolve?: () => unknown): Engine =>
    ({
      resolve:
        resolve ??
        ((_s: unknown, name: string) => ({
          sel: scope.servers[0],
          bare: 'gone',
          server: 'fs',
          name,
        })),
      callResolved,
    }) as unknown as Engine;

  async function stubClient(stubbed: Engine): Promise<Client> {
    const c = new Client({ name: 'test', version: '0.0.0' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL('http://hub.test/mcp'), {
        fetch: (url, init) =>
          handleMcp(new Request(url, init), {
            engine: stubbed,
            scope,
            principal,
            timeoutMs: 5_000,
            resultMaxBytes: 1_048_576,
            gate: ALLOW_ALL_GATE,
            audit: (r) => records.push(r),
          }),
      }),
    );
    return c;
  }

  it('a tool that vanishes between resolve and call is the one not-found error, recorded as not_found', async () => {
    records.length = 0;
    const c = await stubClient(stub(() => Promise.reject(new ToolUnavailableError('fs__gone'))));
    await expect(c.callTool({ name: 'fs__gone' })).rejects.toThrow(/Tool not found: fs__gone/);
    await c.close();
    expect(records.map((r) => [r.server, r.outcome])).toEqual([['fs', 'not_found']]);
  });

  it('a call without arguments records no keys and 2 bytes', async () => {
    records.length = 0;
    const c = await stubClient(stub(() => Promise.resolve({ content: [] })));
    await c.callTool({ name: 'fs__x' });
    await c.close();
    expect(records[0]).toMatchObject({ inputKeys: [], inputBytes: 2, outcome: 'ok' });
  });

  it('a non-Error rejection still becomes an error result with a generic message', async () => {
    records.length = 0;
    const c = await stubClient(stub(() => Promise.reject('weird')));
    const res = await c.callTool({ name: 'fs__x' });
    await c.close();
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('tool call failed');
  });

  it('an unexpected resolve failure is a protocol error, not a hidden success', async () => {
    const c = await stubClient(
      stub(
        () => Promise.resolve({ content: [] }),
        () => {
          throw new Error('registry exploded');
        },
      ),
    );
    await expect(c.callTool({ name: 'fs__x' })).rejects.toThrow(/registry exploded/);
    await c.close();
  });
});

describe('batches', () => {
  it('a JSON-RPC batch is refused before anything runs — one POST must be one call (§4.2 limit)', async () => {
    records.length = 0;
    const one = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'fs__echo', arguments: {} },
    };
    const res = await handleMcp(
      new Request('http://hub.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify([
          { ...one, id: 1 },
          { ...one, id: 2 },
        ]),
      }),
      call(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32600 }, id: null });
    expect(records).toEqual([]);
  });
});

describe('result cap (§4.2)', () => {
  it('passes a result under the cap untouched', () => {
    const r = { content: [{ type: 'text' as const, text: 'ok' }] };
    expect(capResult(r, 1_000)).toBe(r);
  });

  it('truncates a result over the cap with the marker, keeping isError', async () => {
    const c2 = new Client({ name: 't', version: '0' });
    await c2.connect(
      new StreamableHTTPClientTransport(new URL('http://hub.test/mcp'), {
        fetch: (url, init) => handleMcp(new Request(url, init), handleMcpCap(1_000)),
      }),
    );
    const res = await c2.callTool({ name: 'fs__big', arguments: {} });
    await c2.close();
    const text = JSON.stringify(res.content);
    expect(text).toMatch(/\[mcprouter:truncated \d+ bytes\]/);
    expect(Buffer.byteLength(text)).toBeLessThan(1_200);
    expect(
      capResult({ isError: true, content: [{ type: 'text', text: 'z'.repeat(2_000) }] }, 500)
        .isError,
    ).toBe(true);
  });
});

describe('result cap never exceeds the cap', () => {
  const size = (r: unknown) => Buffer.byteLength(JSON.stringify(r), 'utf8');
  it.each([
    ['quotes (escape ×2)', '"'.repeat(5_000)],
    ['control characters (escape ×6)', '\u0001'.repeat(5_000)],
    ['multi-byte text', 'é'.repeat(5_000)],
  ])('%s', (_n, text) => {
    const out = capResult({ content: [{ type: 'text', text }] }, 1_024);
    expect(size(out)).toBeLessThanOrEqual(1_024);
    expect(JSON.stringify(out)).toMatch(/\[mcprouter:truncated \d+ bytes\]/);
  });

  it('structured content that cannot fit is dropped AND flagged isError, so a schema-checking client does not choke', () => {
    const out = capResult(
      { content: [{ type: 'text', text: 'x' }], structuredContent: { rows: 'y'.repeat(5_000) } },
      1_024,
    );
    expect(out.structuredContent).toBeUndefined();
    expect(out.isError).toBe(true);
    expect(size(out)).toBeLessThanOrEqual(1_024);
  });
});

describe('integrity reason on not_found', () => {
  it('records why a name did not resolve — internally only', async () => {
    records.length = 0;
    const c = await client();
    await expect(c.callTool({ name: 'fs__nope', arguments: {} })).rejects.toThrow(
      /Tool not found: fs__nope$/,
    );
    await c.close();
    expect(records[0]).toMatchObject({ outcome: 'not_found', reason: 'missing' });
  });
});

describe('integrity blocks on prompts and resources are recorded too', () => {
  const blocking = (kindSeen: string[]): Engine =>
    ({
      getPrompt: () => Promise.reject(new ToolUnavailableError('fs__p')),
      readResource: () => Promise.reject(new ToolUnavailableError('mem://r')),
      explain: (_s: unknown, _n: string, kind: string) => {
        kindSeen.push(kind);
        return 'changed';
      },
    }) as unknown as Engine;

  it('a changed prompt or resource leaves a record with its reason — and the client the plain not-found', async () => {
    records.length = 0;
    const kinds: string[] = [];
    const c = new Client({ name: 't', version: '0' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL('http://hub.test/mcp'), {
        fetch: (url, init) =>
          handleMcp(new Request(url, init), { ...call(), engine: blocking(kinds) }),
      }),
    );
    await expect(c.getPrompt({ name: 'fs__p' })).rejects.toThrow(/Tool not found: fs__p$/);
    await expect(c.readResource({ uri: 'mem://r' })).rejects.toThrow(/Tool not found: mem:\/\/r$/);
    await c.close();
    expect(kinds).toEqual(['prompt', 'resource']);
    expect(records.map((r) => [r.item, r.outcome, r.reason])).toEqual([
      ['fs__p', 'not_found', 'changed'],
      ['mem://r', 'not_found', 'changed'],
    ]);
  });
});

describe('policy deny (stub gate)', () => {
  it('the caller reads the note as an error result; nothing reaches the upstream; the record says denied', async () => {
    records.length = 0;
    let called = false;
    const guarded: McpCall = {
      ...call(),
      engine: {
        resolve: () => ({ sel: scope.servers[0], bare: 'echo', server: 'fs' }),
        callResolved: () => {
          called = true;
          return Promise.resolve({ content: [] });
        },
      } as unknown as Engine,
      gate: () => ({
        ok: false,
        ruleId: 'r9',
        note: 'writes are frozen today',
        reason: { k: 'selector' },
      }),
    };
    const c = new Client({ name: 't', version: '0' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL('http://hub.test/mcp'), {
        fetch: (url, init) => handleMcp(new Request(url, init), guarded),
      }),
    );
    const res = await c.callTool({ name: 'fs__echo', arguments: { text: 'x' } });
    await c.close();
    expect(res).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Denied by policy: writes are frozen today' }],
    });
    expect(called).toBe(false);
    expect(records).toEqual([
      expect.objectContaining({ outcome: 'denied', error: 'policy:r9', item: 'echo' }),
    ]);
  });
});
