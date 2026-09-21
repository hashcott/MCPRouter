import { describe, expect, it } from 'vitest';
import { currentContext, newRequestId, runWithContext } from './context.js';

describe('request context', () => {
  it('mints a valid W3C trace-id', () => {
    const id = newRequestId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toBe('0'.repeat(32));
  });

  it('is undefined outside a run', () => {
    expect(currentContext()).toBeUndefined();
  });

  it('propagates across await boundaries', async () => {
    const ctx = { requestId: newRequestId(), principal: null, server: null };
    await runWithContext(ctx, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentContext()?.requestId).toBe(ctx.requestId);
    });
    expect(currentContext()).toBeUndefined();
  });

  it('keeps two concurrent runs isolated', async () => {
    const a = { requestId: newRequestId(), principal: null, server: null };
    const b = { requestId: newRequestId(), principal: null, server: null };
    const seen = await Promise.all([
      runWithContext(a, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentContext()?.requestId;
      }),
      runWithContext(b, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return currentContext()?.requestId;
      }),
    ]);
    expect(seen).toEqual([a.requestId, b.requestId]);
  });

  it('lets a late writer set principal in place', async () => {
    const ctx: { requestId: string; principal: string | null; server: string | null } = {
      requestId: newRequestId(),
      principal: null,
      server: null,
    };
    await runWithContext(ctx, async () => {
      currentContext()!.principal = 'user_1';
      await new Promise((r) => setTimeout(r, 1));
      expect(currentContext()?.principal).toBe('user_1');
    });
  });
});
