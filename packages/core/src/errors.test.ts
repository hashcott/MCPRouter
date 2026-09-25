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
