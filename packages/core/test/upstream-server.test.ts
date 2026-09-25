import { describe, expect, it, vi } from 'vitest';
import { Bus, type EngineEvents } from '../src/bus.js';
import { Semaphore } from '../src/semaphore.js';
import { UpstreamServer, configHashOf, envInt } from '../src/upstream-server.js';
import { UpstreamUnavailableError } from '../src/errors.js';
import type { ServerConfig } from '../src/types.js';
import { FakeUpstream, fakeFactory } from './fake-upstream.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Tiny backoff so a retry test finishes in milliseconds without fake timers. */
const FAST_RETRY = { baseMs: 5, maxMs: 20 };

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
    logger,
    retry: FAST_RETRY,
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
    const fake = new FakeUpstream('fs', [], { failConnect: 'permanent' });
    const { srv } = make(fake);
    srv.start();
    await vi.waitFor(() => expect(srv.state).toBe('failed'));
    await new Promise((r) => setTimeout(r, 60));
    expect(fake.connects).toBe(1);
    await srv.stop('closed');
  });

  it('a transient failure retries with backoff and eventually succeeds', async () => {
    const fake = new FakeUpstream('fs', [{ name: 't' }], { failConnect: 'transient' });
    const { srv } = make(fake);
    srv.start();
    await vi.waitFor(() => expect(srv.state).toBe('retrying'));

    (fake.knobs as { failConnect?: string | undefined }).failConnect = undefined;
    await vi.waitFor(() => expect(srv.state).toBe('ready'), { timeout: 3000 });
    expect(fake.connects).toBeGreaterThanOrEqual(2);
    await srv.stop('closed');
  });

  it('keeps serving the previous catalog while reconnecting, marked stale', async () => {
    const fake = new FakeUpstream('fs', [{ name: 't' }]);
    const { srv } = make(fake);
    srv.start();
    await srv.ensureReady(2000);

    // Make the next connect fail so it parks in retrying rather than racing back to ready.
    (fake.knobs as { failConnect?: string | undefined }).failConnect = 'transient';
    await fake.drop();

    await vi.waitFor(() => expect(srv.state).toBe('retrying'));
    expect(srv.stale).toBe(true);
    expect(srv.catalog?.tools.has('t')).toBe(true);
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
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.connects).toBe(before);
    expect(srv.state).toBe('closed');
  });

  it('configHashOf is stable across key order and changes with a value', () => {
    const a = configHashOf(cfg({ tools: { x: { enabled: true }, y: { enabled: false } } }));
    const b = configHashOf(cfg({ tools: { y: { enabled: false }, x: { enabled: true } } }));
    expect(a).toBe(b);
    expect(configHashOf(cfg({ command: 'other' }))).not.toBe(a);
  });

  it('bounds the stderr ring at 200 lines', () => {
    const fake = new FakeUpstream('fs', [{ name: 't' }]);
    const { srv } = make(fake);
    for (let i = 0; i < 250; i += 1) srv.pushStderrForTest(`line ${i}`);
    expect(srv.stderrTail).toHaveLength(200);
    expect(srv.stderrTail[199]).toBe('line 249');
  });

  it('closes the connection when discovery fails, instead of leaking one per retry', async () => {
    const fake = new FakeUpstream('fs', [{ name: 't' }], { failList: true });
    const { srv } = make(fake);
    srv.start();
    await vi.waitFor(() => expect(fake.connects).toBeGreaterThanOrEqual(4));
    expect(fake.open).toBeLessThanOrEqual(1);
    await srv.stop('closed');
    expect(fake.open).toBe(0);
  });

  it('stop() during a hung handshake closes the half-open transport', async () => {
    const fake = new FakeUpstream('fs', [], { silent: true });
    const { srv } = make(fake);
    srv.start();
    await vi.waitFor(() => expect(fake.open).toBe(1));
    await srv.stop('closed');
    expect(fake.open).toBe(0);
  });

  it('re-lists on an upstream tools/list_changed without reconnecting', async () => {
    const fake = new FakeUpstream('fs', [{ name: 'a' }]);
    const { srv } = make(fake);
    srv.start();
    await vi.waitFor(() => expect(srv.state).toBe('ready'));
    fake.setTools([{ name: 'a' }, { name: 'b' }]);
    await vi.waitFor(() => expect([...(srv.catalog?.tools.keys() ?? [])]).toEqual(['a', 'b']));
    expect(fake.connects).toBe(1);
    await srv.stop('closed');
  });

  it('refresh() outside ready does not start a discovery', async () => {
    const fake = new FakeUpstream('fs', [{ name: 'a' }]);
    const { srv } = make(fake);
    srv.refresh();
    expect(srv.state).toBe('idle');
    expect(fake.connects).toBe(0);
    await srv.stop('closed');
  });

  it.each(['', 'abc', '0', '-3'])('envInt falls back when the value is %j', (raw) => {
    process.env['MCPROUTER_TEST_INT'] = raw;
    expect(envInt('MCPROUTER_TEST_INT', 7)).toBe(7);
    delete process.env['MCPROUTER_TEST_INT'];
  });

  it('envInt reads a valid value and honours min 0', () => {
    process.env['MCPROUTER_TEST_INT'] = '0';
    expect(envInt('MCPROUTER_TEST_INT', 7, 0)).toBe(0);
    process.env['MCPROUTER_TEST_INT'] = '12';
    expect(envInt('MCPROUTER_TEST_INT', 7)).toBe(12);
    delete process.env['MCPROUTER_TEST_INT'];
  });
});
