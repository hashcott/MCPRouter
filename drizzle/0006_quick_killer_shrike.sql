CREATE TABLE "policy_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"subject_kind" text DEFAULT 'any' NOT NULL,
	"subject_id" text,
	"server_id" uuid NOT NULL,
	"item_kind" text DEFAULT 'tool' NOT NULL,
	"name_pattern" text DEFAULT '*' NOT NULL,
	"effect" text NOT NULL,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" varchar(200),
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_rule_seq_uq" UNIQUE("seq"),
	CONSTRAINT "policy_rule_subject_kind" CHECK ("policy_rule"."subject_kind" in ('any', 'role', 'api_key')),
	CONSTRAINT "policy_rule_subject_iff" CHECK (("policy_rule"."subject_kind" = 'any') = ("policy_rule"."subject_id" is null)),
	CONSTRAINT "policy_rule_role" CHECK ("policy_rule"."subject_kind" <> 'role' or "policy_rule"."subject_id" in ('viewer', 'operator', 'admin')),
	CONSTRAINT "policy_rule_item_kind" CHECK ("policy_rule"."item_kind" in ('tool', 'prompt', 'resource')),
	CONSTRAINT "policy_rule_effect" CHECK ("policy_rule"."effect" in ('allow', 'deny')),
	CONSTRAINT "policy_rule_pattern" CHECK ("policy_rule"."name_pattern" ~ '^[A-Za-z0-9_*.:/-]{1,128}$'),
	CONSTRAINT "policy_rule_args_array" CHECK (jsonb_typeof("policy_rule"."args") = 'array'),
	CONSTRAINT "policy_rule_no_args_on_deny" CHECK ("policy_rule"."effect" <> 'deny' or jsonb_array_length("policy_rule"."args") = 0)
);
--> statement-breakpoint
ALTER TABLE "audit_event" ADD COLUMN "count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_rule" ADD CONSTRAINT "policy_rule_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;