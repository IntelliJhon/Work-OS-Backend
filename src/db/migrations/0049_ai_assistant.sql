-- Migration: 0049_ai_assistant
-- The in-app AI assistant (Claude): each person's chats, the files they share in them, and actions that leave Work OS
-- (e.g. a proposal sent to a client on WhatsApp), which wait for the person to click Send.
-- No RLS: every query filters by tenant_id and user_id.
CREATE TABLE IF NOT EXISTS "ai_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "title" varchar(160) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_conversations_user" ON "ai_conversations" ("tenant_id", "user_id", "updated_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ai_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq" bigserial NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "ai_conversations"("id") ON DELETE CASCADE,
  -- user | assistant
  "role" varchar(10) NOT NULL,
  -- The message as sent to / returned by Claude (content blocks), kept unchanged so the history can be replayed
  "content" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_messages_conversation" ON "ai_messages" ("conversation_id", "seq");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ai_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "ai_conversations"("id") ON DELETE CASCADE,
  -- The copy in Work OS (attached to leads from here) and the copy Claude reads
  "upload_id" uuid REFERENCES "uploads"("id") ON DELETE SET NULL,
  "claude_file_id" varchar(120),
  "name" varchar(255) NOT NULL,
  "mime_type" varchar(100) NOT NULL,
  "size" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_files_conversation" ON "ai_files" ("conversation_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ai_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "ai_conversations"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- send_proposal
  "kind" varchar(30) NOT NULL,
  -- What will happen, e.g. { leadId, proposalId, version, to, fileName }
  "payload" jsonb NOT NULL,
  -- pending | done | failed | cancelled
  "status" varchar(12) DEFAULT 'pending' NOT NULL,
  "result" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_actions_conversation" ON "ai_actions" ("conversation_id");
