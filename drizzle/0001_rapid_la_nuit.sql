CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"server_id" uuid,
	"user_id" text,
	"label" text NOT NULL,
	"key_version" smallint NOT NULL,
	"iv" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_scope" CHECK ("secrets"."scope" in ('server_env', 'server_header', 'server_oauth_client', 'credential', 'upstream_access', 'upstream_refresh')),
	CONSTRAINT "secrets_iv_len" CHECK (octet_length("secrets"."iv") = 12),
	CONSTRAINT "secrets_tag_len" CHECK (octet_length("secrets"."tag") = 16),
	CONSTRAINT "secrets_ct_len" CHECK (octet_length("secrets"."ciphertext") between 1 and 65536),
	CONSTRAINT "secrets_key_version" CHECK ("secrets"."key_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"credential_mode" text DEFAULT 'shared' NOT NULL,
	"allow_private_network" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "servers_slug_fmt" CHECK ("servers"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
	CONSTRAINT "servers_credential_mode" CHECK ("servers"."credential_mode" in ('shared', 'per-user')),
	CONSTRAINT "servers_no_inline_secret" CHECK (not jsonb_path_exists("servers"."config", '$.env.* ? (@.type() != "object")')
        and not jsonb_path_exists("servers"."config", '$.headers.* ? (@.type() != "object")'))
);
--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secrets_server_idx" ON "secrets" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "servers_slug_uq" ON "servers" USING btree ("slug");