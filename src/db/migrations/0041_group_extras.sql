-- Migration: 0041_group_extras
-- Group chat extras: replies, pinned messages, and saved AI summaries. "Seen by" needs no table: a member has
-- seen a message when their chat_group_members.last_read_at is at or after it.
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "reply_to_id" uuid REFERENCES "chat_messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "pinned_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_messages_pinned" ON "chat_messages" ("group_id") WHERE "pinned_at" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "chat_summaries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "group_id" uuid NOT NULL REFERENCES "chat_groups"("id") ON DELETE CASCADE,
  -- Local days (WORK_TIMEZONE), inclusive
  "from_day" date NOT NULL,
  "to_day" date NOT NULL,
  -- { keyPoints[], decisions[], actionItems[{ text, person, personId, due }], openQuestions[] }
  "content" jsonb NOT NULL,
  "message_count" integer NOT NULL,
  -- The newest message it covers; a newer message makes the summary out of date
  "last_message_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chat_summaries_group_range_unique" UNIQUE ("group_id", "from_day", "to_day")
);
