import { describe, expect, it } from 'vitest';
import { clientConfig } from './index.js';

describe('clientConfig — the URL is a route the grant actually passes on', () => {
  const hub = new URL('https://hub.example.com');
  it.each([
    ['unscoped → /mcp', [], [], ['https://hub.example.com/mcp']],
    ['one group → its route', ['eng'], [], ['https://hub.example.com/mcp/g/eng']],
    [
      'two groups → both routes',
      ['eng', 'ops'],
      [],
      ['https://hub.example.com/mcp/g/eng', 'https://hub.example.com/mcp/g/ops'],
    ],
    // /mcp holds every server: a servers grant passes only on each server's own route (§4.2).
    [
      'servers → each server route, never /mcp',
      [],
      ['fs', 'gh'],
      ['https://hub.example.com/mcp/s/fs', 'https://hub.example.com/mcp/s/gh'],
    ],
  ])('%s', (_n, groups, servers, urls) => {
    const c = clientConfig(hub, groups, servers, 'mcpr_k');
    expect(c.urls).toEqual(urls);
    expect(c.url).toBe(urls[0]);
  });

  it('keeps a PUBLIC_URL path prefix, and builds the pasteable blocks', () => {
    const c = clientConfig(new URL('https://corp.example.com/tools/hub/'), ['eng'], [], 'mcpr_k');
    expect(c.url).toBe('https://corp.example.com/tools/hub/mcp/g/eng');
    expect(c.json).toEqual({
      mcpServers: {
        mcprouter: { type: 'http', url: c.url, headers: { Authorization: 'Bearer mcpr_k' } },
      },
    });
    expect(c.claudeCode).toBe(
      `claude mcp add --transport http mcprouter ${c.url} --header "Authorization: Bearer mcpr_k"`,
    );
  });
});
