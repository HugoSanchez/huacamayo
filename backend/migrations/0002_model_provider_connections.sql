CREATE TABLE "model_provider_connections" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"key_last4" text NOT NULL,
	"key_sha256_prefix" text NOT NULL,
	"centaur_static_secret_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_provider_connections_user_provider_pk" PRIMARY KEY("user_id","provider")
);
