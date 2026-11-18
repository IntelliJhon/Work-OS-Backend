-- Migration: 0058_campaign_batches
-- Campaign messages now go out through WAAU's Bulk Campaign API: each round, the contacts due the same message are sent
-- as one WAAU campaign. A batch remembers that campaign and its report counts (sent / delivered / read / replied / failed).
CREATE TABLE IF NOT EXISTS "campaign_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "sequence_id" uuid NOT NULL REFERENCES "campaign_sequences"("id") ON DELETE CASCADE,
  "day" integer NOT NULL,
  "template_name" varchar(120) NOT NULL,
  "waau_campaign_id" varchar(64),
  "recipients" integer NOT NULL,
  -- WAAU report counts (refreshed for a few days after sending)
  "sent" integer DEFAULT 0 NOT NULL,
  "delivered" integer DEFAULT 0 NOT NULL,
  "read" integer DEFAULT 0 NOT NULL,
  "replied" integer DEFAULT 0 NOT NULL,
  "failed" integer DEFAULT 0 NOT NULL,
  "report_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_campaign_batches_sequence" ON "campaign_batches" ("sequence_id", "created_at");--> statement-breakpoint
ALTER TABLE "campaign_messages" ADD COLUMN IF NOT EXISTS "batch_id" uuid REFERENCES "campaign_batches"("id") ON DELETE SET NULL;
