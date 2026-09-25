import { describe, expect, it } from 'vitest';
import { CliError, parseGroupAdd, parseServerAdd, secretLines } from './commands.js';

describe('secretLines', () => {
  it('prints an AUTH_SECRET and a keyring line, fresh each time', () => {
    const [a, k] = secretLines();
    expect(a).toMatch(/^AUTH_SECRET=[A-Za-z0-9_-]{43}$/);
    expect(k).toMatch(/^MCPR_SECRET_KEYS=v1:[A-Za-z0-9_-]{43}$/);
    expect(secretLines()[0]).not.toBe(a);
  });
});

describe('parseServerAdd', () => {
  it('stdio: the command follows --, env values literal or taken from the environment', () => {
    const s = parseServerAdd(
      ['fs', '--env', 'A=1', '--env', 'TOKEN', '--cwd', '/srv', '--', 'npx', '-y', 'pkg', '/tmp'],
      { TOKEN: 's3cret' },
    );
    expect(s).toEqual({
      slug: 'fs',
      enabled: true,
      allowPrivateNetwork: false,
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg', '/tmp'],
        env: { A: '1', TOKEN: 's3cret' },
        cwd: '/srv',
      },
    });
  });

  it('http: --url, --sse, headers literal or from the environment', () => {
    const s = parseServerAdd(
      [
        'gh',
        '--url',
        'https://mcp.example.com/sse',
        '--sse',
        '--header',
        'X-Team=core',
        '--header',
        'Authorization',
        '--allow-private-network',
        '--disabled',
      ],
      { AUTHORIZATION: 'Bearer t' },
    );
    expect(s).toEqual({
      slug: 'gh',
      enabled: false,
      allowPrivateNetwork: true,
      config: {
        type: 'sse',
        url: 'https://mcp.example.com/sse',
        headers: { 'X-Team': 'core', Authorization: 'Bearer t' },
      },
    });
  });

  it('defaults to streamable-http without --sse', () => {
    expect(parseServerAdd(['r', '--url', 'https://a.example/mcp'], {}).config.type).toBe(
      'streamable-http',
    );
  });

  it.each([
    ['no slug', []],
    ['neither --url nor a command', ['fs']],
    ['both --url and a command', ['fs', '--url', 'https://a.example', '--', 'npx']],
    ['an env name missing from the environment', ['fs', '--env', 'NOPE', '--', 'npx']],
    ['an unknown flag', ['fs', '--shell', '--', 'npx']],
  ])('rejects %s', (_n, argv) => {
    expect(() => parseServerAdd(argv, {})).toThrow(CliError);
  });
});

describe('parseGroupAdd', () => {
  it('--server alone selects everything; --server s=a,b selects those tools', () => {
    expect(
      parseGroupAdd(['eng', '--server', 'fs', '--server', 'gh=create_issue,list_issues']),
    ).toEqual({
      slug: 'eng',
      members: [
        { server: 'fs', tools: 'all' },
        { server: 'gh', tools: ['create_issue', 'list_issues'] },
      ],
    });
  });

  it('a group may start empty', () => {
    expect(parseGroupAdd(['empty'])).toEqual({ slug: 'empty', members: [] });
  });

  it.each([
    ['no slug', []],
    ['an empty tool list', ['g', '--server', 'fs=']],
    ['an unknown flag', ['g', '--alias', 'x']],
  ])('rejects %s', (_n, argv) => expect(() => parseGroupAdd(argv)).toThrow(CliError));
});
