CREATE TABLE "audit_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"evt" text NOT NULL,
	"request_id" text,
	"principal_id" text,
	"key_id" text,
	"route" text,
	"server" text,
	"item" text,
	"outcome" text,
	"duration_ms" integer,
	"input_keys" text[],
	"input_bytes" integer,
	"error" text,
	CONSTRAINT "audit_event_outcome" CHECK ("audit_event"."outcome" is null or "audit_event"."outcome" in ('ok', 'error', 'denied', 'not_found', 'timeout'))
);
--> statement-breakpoint
CREATE TABLE "group_server" (
	"group_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"alias" text,
	"tools" jsonb DEFAULT '"all"'::jsonb NOT NULL,
	"prompts" jsonb DEFAULT '"all"'::jsonb NOT NULL,
	"resources" jsonb DEFAULT '"all"'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_server_group_id_server_id_pk" PRIMARY KEY("group_id","server_id"),
	CONSTRAINT "group_server_alias_fmt" CHECK ("group_server"."alias" is null or "group_server"."alias" ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
	CONSTRAINT "group_server_selection" CHECK (("group_server"."tools" = '"all"'::jsonb or jsonb_typeof("group_server"."tools") = 'array') and ("group_server"."prompts" = '"all"'::jsonb or jsonb_typeof("group_server"."prompts") = 'array') and ("group_server"."resources" = '"all"'::jsonb or jsonb_typeof("group_server"."resources") = 'array'))
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_slug_fmt" CHECK ("groups"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$')
);
--> statement-breakpoint
CREATE TABLE "server_item_override" (
	"server_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"item_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_item_override_server_id_kind_item_name_pk" PRIMARY KEY("server_id","kind","item_name"),
	CONSTRAINT "server_item_override_kind" CHECK ("server_item_override"."kind" in ('tool', 'prompt', 'resource'))
);
--> statement-breakpoint
ALTER TABLE "group_server" ADD CONSTRAINT "group_server_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_server" ADD CONSTRAINT "group_server_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_item_override" ADD CONSTRAINT "server_item_override_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_at_idx" ON "audit_event" USING btree ("at");--> statement-breakpoint
CREATE INDEX "group_server_server_idx" ON "group_server" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_server_alias_uq" ON "group_server" USING btree ("group_id","alias");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_slug_uq" ON "groups" USING btree ("slug");