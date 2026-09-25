import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Engine, ToolUnavailableError, type Principal, type ResolvedScope } from '@mcprouter/core';
import { FakeUpstream, fakeFactory } from '../../../core/test/fake-upstream.js';
import { handleMcp, type CallRecord, type McpCall } from './legacy.js';

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
  audit: (r) => records.push(r),
});

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
    expect(tools.map((t) => t.name).sort()).toEqual(['fs__boom', 'fs__echo', 'fs__slow']);
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
    expect(records[1]?.error).toContain('upstream exploded');
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

  async function stubClient(engine: Engine): Promise<Client> {
    const c = new Client({ name: 'test', version: '0.0.0' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL('http://hub.test/mcp'), {
        fetch: (url, init) =>
          handleMcp(new Request(url, init), {
            engine,
            scope,
            principal,
            timeoutMs: 5_000,
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
