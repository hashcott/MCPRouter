import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import type { Principal, ResolvedScope, ServerConfig } from '../src/types.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const principal: Principal = { id: 'u1', isAdmin: true };

/** Unique to this test's child, so the orphan check matches nothing else. */
const MARKER = 'mcprouter-stdio-itest-upstream';

/** A minimal, dependency-free MCP server over stdio, written inline. */
const UPSTREAM = `
// ${MARKER}
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
  // `node -e` resolves require() from cwd; under the isolated linker the SDK
  // is only linked into packages/core/node_modules (Ruling P15).
  cwd: fileURLToPath(new URL('..', import.meta.url)),
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
    .filter((l) => l.includes(MARKER))
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((p) => p.length > 0);
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
    expect(childPids()).toHaveLength(1); // the marker really identifies the child

    await engine.shutdown();
    await new Promise((r) => setTimeout(r, 500));
    expect(childPids()).toEqual([]);
  }, 60_000);
});
