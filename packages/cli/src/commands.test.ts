import { describe, expect, it } from 'vitest';
import {
  CliError,
  parseArgSpec,
  parseGroupAdd,
  parsePolicyAdd,
  parseServerAdd,
  secretLines,
} from './commands.js';

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

describe('parseArgSpec — op:/pointer[=value]', () => {
  it.each([
    ['present:/path', { op: 'present', ptr: '/path' }],
    ['absent:/opts/force', { op: 'absent', ptr: '/opts/force' }],
    ['equals:/mode=ro', { op: 'equals', ptr: '/mode', value: 'ro' }],
    ['oneOf:/mode=ro,rw', { op: 'oneOf', ptr: '/mode', values: ['ro', 'rw'] }],
    ['prefix:/url=https://', { op: 'prefix', ptr: '/url', value: 'https://' }],
    ['pathUnder:/path=/srv/data', { op: 'pathUnder', ptr: '/path', value: '/srv/data' }],
    ['maxLen:/q=100', { op: 'maxLen', ptr: '/q', n: 100 }],
    ['equals:/k=a=b', { op: 'equals', ptr: '/k', value: 'a=b' }],
  ])('%s', (spec, want) => expect(parseArgSpec(spec)).toEqual(want));

  it.each(['regex:/p=.*', 'present', 'maxLen:/q=lots', 'equals:not-a-pointer=x', 'oneOf:/m='])(
    'rejects %s',
    (spec) => expect(() => parseArgSpec(spec)).toThrow(CliError),
  );
});

describe('parsePolicyAdd', () => {
  const now = Date.UTC(2026, 0, 1);
  it('a role-scoped deny with a note that expires', () => {
    expect(
      parsePolicyAdd(
        [
          'fs',
          '--deny',
          '--name',
          'write_*',
          '--role',
          'viewer',
          '--note',
          'read only',
          '--expires',
          '2h',
        ],
        now,
      ),
    ).toEqual({
      server: 'fs',
      effect: 'deny',
      kind: 'tool',
      pattern: 'write_*',
      subject: { kind: 'role', id: 'viewer' },
      args: [],
      note: 'read only',
      expiresAt: new Date(now + 2 * 3_600_000),
      seq: null,
    });
  });

  it('a key-scoped constrained allow at an explicit position', () => {
    const p = parsePolicyAdd(
      ['fs', '--allow', '--key', 'k1', '--arg', 'pathUnder:/path=/srv', '--seq', '5'],
      now,
    );
    expect(p).toMatchObject({ effect: 'allow', subject: { kind: 'api_key', id: 'k1' }, seq: 5 });
    expect(p.args).toEqual([{ op: 'pathUnder', ptr: '/path', value: '/srv' }]);
  });

  it.each([
    ['neither --allow nor --deny', ['fs']],
    ['both', ['fs', '--allow', '--deny']],
    ['no server', ['--deny']],
    ['constraints on a deny', ['fs', '--deny', '--arg', 'present:/x']],
    ['role and key together', ['fs', '--deny', '--role', 'viewer', '--key', 'k']],
    ['an unknown role', ['fs', '--deny', '--role', 'root']],
    ['a regex name', ['fs', '--deny', '--name', 'write_(a|b)']],
    ['a bad kind', ['fs', '--deny', '--kind', 'widget']],
    ['a bad expiry', ['fs', '--deny', '--expires', 'soon']],
    ['a negative seq', ['fs', '--deny', '--seq', '-1']],
    ['a note over 200 characters', ['fs', '--deny', '--note', 'x'.repeat(201)]],
  ])('rejects %s', (_n, argv) => expect(() => parsePolicyAdd(argv, now)).toThrow(CliError));
});
