import { stampDecision, type Decision, type ToolDecision } from '@mcprouter/core';
import { evaluate, type CompiledRule, type DenyReason, type PolicySubject } from './policy.js';

export type GateResult =
  | { ok: true; decision: Decision; ruleId: string | null }
  | { ok: false; ruleId: string; note: string | null; reason: DenyReason };

/** Between resolve and execute (§11.4): the ONLY thing that turns a resolution into a Decision. */
export type Gate = (tool: ToolDecision, args: Record<string, unknown>) => GateResult;

/**
 * The policy gate. `stampDecision` is called here and nowhere else in packages/server
 * (a source-scan test pins it): skipping the gate is a compile error at callResolved,
 * not a convention two lines happen to follow.
 *
 * Order (§11.4): … resolveTool → policy.evaluate → [egress scan, P4] → [approval, later]
 * → Decision → callResolved.
 */
export function makeGate(o: {
  rules: readonly CompiledRule[];
  /** The id policy rules are keyed on; the name → id map of the snapshot the route came from. */
  serverIdOf: (serverName: string) => string | undefined;
  subject: PolicySubject;
  now?: () => number;
  onDecision?: (effect: 'allow' | 'deny') => void;
}): Gate {
  return (tool, args) => {
    const serverId = o.serverIdOf(tool.server);
    // A resolved tool whose server has no id in the snapshot cannot be evaluated: fail closed.
    if (serverId === undefined) {
      o.onDecision?.('deny');
      return { ok: false, ruleId: 'unresolvable-server', note: null, reason: { k: 'selector' } };
    }
    const d = evaluate(o.rules, {
      subject: o.subject,
      serverId,
      kind: 'tool',
      bare: tool.bare,
      args,
      now: (o.now ?? Date.now)(),
    });
    o.onDecision?.(d.effect);
    if (d.effect === 'deny') return { ok: false, ruleId: d.ruleId, note: d.note, reason: d.reason };
    // Serialized once, here; callResolved dispatches exactly these bytes.
    return { ok: true, decision: stampDecision(tool, args), ruleId: d.ruleId };
  };
}

/** For tests and embedding ONLY — must be passed explicitly, never a default (§11.4). */
export const ALLOW_ALL_GATE: Gate = (tool, args) => ({
  ok: true,
  decision: stampDecision(tool, args),
  ruleId: null,
});

/** What the caller reads on a deny: the operator's note, and that it was policy (§11.1). */
export function denyText(note: string | null): string {
  return note === null ? 'Denied by policy.' : `Denied by policy: ${note}`;
}
