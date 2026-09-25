CREATE TABLE "tool_embedding" (
	"server_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"def" jsonb NOT NULL,
	"def_hash" text,
	"shape_hash" text,
	"defect" text,
	"def_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_embedding_server_id_kind_name_pk" PRIMARY KEY("server_id","kind","name"),
	CONSTRAINT "tool_embedding_kind" CHECK ("tool_embedding"."kind" in ('tool', 'prompt', 'resource')),
	CONSTRAINT "tool_embedding_hash_xor_defect" CHECK (("tool_embedding"."def_hash" is not null and "tool_embedding"."shape_hash" is not null and "tool_embedding"."defect" is null)
        or ("tool_embedding"."def_hash" is null and "tool_embedding"."shape_hash" is null and "tool_embedding"."defect" is not null))
);
--> statement-breakpoint
ALTER TABLE "server_item_override" ADD COLUMN "review_state" text;--> statement-breakpoint
ALTER TABLE "server_item_override" ADD COLUMN "approved_hash" text;--> statement-breakpoint
ALTER TABLE "server_item_override" ADD COLUMN "approved_def" jsonb;--> statement-breakpoint
ALTER TABLE "server_item_override" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "server_item_override" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "first_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tool_embedding" ADD CONSTRAINT "tool_embedding_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_item_override" ADD CONSTRAINT "server_item_override_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_item_override" ADD CONSTRAINT "server_item_override_review_state" CHECK ("server_item_override"."review_state" is null or "server_item_override"."review_state" in ('approved', 'unreviewed', 'rejected'));--> statement-breakpoint
ALTER TABLE "server_item_override" ADD CONSTRAINT "server_item_override_approval_complete" CHECK ("server_item_override"."review_state" is distinct from 'approved' or ("server_item_override"."approved_hash" is not null and "server_item_override"."approved_def" is not null and "server_item_override"."approved_at" is not null));