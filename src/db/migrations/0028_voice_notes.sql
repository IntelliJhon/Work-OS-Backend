-- Migration: 0028_voice_notes
-- Voice notes via WhatsApp: per-tenant verified sender number + voice_notes inbox table.

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "voice_phone" varchar(20);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "voice_phone_verified_at" timestamp;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "voice_phone_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "voice_phone_pending" varchar(20);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "voice_phone_otp_hash" varchar(64);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "voice_phone_otp_expires_at" timestamp;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "voice_phone_otp_sent_at" timestamp;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "voice_phone_otp_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tenants" ADD CONSTRAINT "tenants_voice_phone_unique" UNIQUE ("voice_phone");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "sender_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "sender_phone" varchar(20) NOT NULL,
  "external_message_id" varchar(255) NOT NULL,
  "audio_url" text,
  "original_transcript" text,
  "english_text" text NOT NULL,
  "detected_language" varchar(50),
  "status" varchar(20) DEFAULT 'new' NOT NULL,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "reviewed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "voice_notes_external_message_id_unique" UNIQUE ("external_message_id"),
  CONSTRAINT "voice_notes_status_check" CHECK ("status" IN ('new', 'converted', 'dismissed', 'unclear'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_voice_notes_tenant_created" ON "voice_notes" ("tenant_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_voice_notes_tenant_status" ON "voice_notes" ("tenant_id", "status");
