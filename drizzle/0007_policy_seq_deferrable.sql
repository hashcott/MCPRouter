-- Hand-written: drizzle cannot express DEFERRABLE. A reorder rewrites every seq
-- (seq = idx * 10) in one transaction; an immediate UNIQUE would trip on the
-- first intermediate collision (§11.3). Postgres cannot ALTER a UNIQUE's
-- deferrability, so the constraint is re-created.
ALTER TABLE "policy_rule" DROP CONSTRAINT "policy_rule_seq_uq";--> statement-breakpoint
ALTER TABLE "policy_rule" ADD CONSTRAINT "policy_rule_seq_uq" UNIQUE ("seq") DEFERRABLE INITIALLY DEFERRED;
