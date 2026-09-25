import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';

const KEY = `v1:${Buffer.alloc(32, 9).toString('base64url')}`;

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/mcprouter',
  AUTH_SECRET: 'x'.repeat(32),
  PUBLIC_URL: 'https://hub.example.com',
  MCPR_SECRET_KEYS: KEY,
};

describe('parseConfig', () => {
  it('accepts a minimal valid environment', () => {
    const r = parseConfig(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.port).toBe(3000);
    expect(r.config.logLevel).toBe('info');
    expect(r.config.publicUrl.href).toBe('https://hub.example.com/');
  });

  it('reports EVERY missing required variable, not just the first', () => {
    const r = parseConfig({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const joined = r.issues.join('\n');
    expect(joined).toContain('DATABASE_URL');
    expect(joined).toContain('AUTH_SECRET');
    expect(joined).toContain('PUBLIC_URL');
    expect(joined).toContain('MCPR_SECRET_KEYS');
  });

  it('rejects a short AUTH_SECRET with a remediation hint', () => {
    const r = parseConfig({ ...valid, AUTH_SECRET: 'tooshort' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.join('\n')).toMatch(/AUTH_SECRET: .*32 characters.*mcprouter secret/s);
  });

  it('never echoes a secret value in an issue', () => {
    const r = parseConfig({ ...valid, AUTH_SECRET: 'sup3r-s3cret-but-short' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.join('\n')).not.toContain('sup3r-s3cret-but-short');
  });

  it('reads a secret from <VAR>_FILE when the var itself is absent', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'mcpr-'));
    const file = join(dir, 'secret');
    await writeFile(file, `${'y'.repeat(40)}\n`);

    const { AUTH_SECRET: _drop, ...rest } = valid;
    const r = parseConfig({ ...rest, AUTH_SECRET_FILE: file });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.authSecret).toBe('y'.repeat(40));
  });

  it('redacts secrets in toJSON so a stray logger.info({config}) cannot leak', () => {
    const r = parseConfig(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dumped = JSON.stringify(r.config);
    expect(dumped).not.toContain('x'.repeat(32));
    expect(dumped).toContain('[redacted]');
    expect(dumped).not.toContain(':p@');
    expect(dumped).not.toContain(KEY.slice(3));
    expect(JSON.parse(dumped).secretKeys).toBe('[redacted]');
  });

  it('parses MCPR_SECRET_KEYS into a keyring', () => {
    const r = parseConfig(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.secretKeys.active).toBe(1);
  });

  it('refuses a missing MCPR_SECRET_KEYS with a generated line to paste', () => {
    const { MCPR_SECRET_KEYS: _drop, ...rest } = valid;
    const r = parseConfig(rest);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const joined = r.issues.join('\n');
    expect(joined).toContain('MCPR_SECRET_KEYS: not set');
    expect(joined).toMatch(/MCPR_SECRET_KEYS=v1:[A-Za-z0-9_-]{43}/);
  });

  it('refuses a malformed MCPR_SECRET_KEYS without echoing it', () => {
    const bad = `v1:${Buffer.alloc(16, 5).toString('base64url')}`;
    const r = parseConfig({ ...valid, MCPR_SECRET_KEYS: bad });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const joined = r.issues.join('\n');
    expect(joined).toContain('MCPR_SECRET_KEYS: v1 must decode to exactly 32 bytes');
    expect(joined).not.toContain(bad);
  });
});
