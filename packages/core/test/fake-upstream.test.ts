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
