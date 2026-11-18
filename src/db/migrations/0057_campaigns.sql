-- Migration: 0057_campaigns
-- Category campaigns: a WhatsApp template sequence per category (Day 1, 3, 7, 15, 30, then monthly) sent to Leads and
-- Enquiry List contacts of that category. Each contact's place in a sequence is an enrolment; it stops when they reply,
-- convert, tap "Not interested" or opt out. Opted-out numbers are never messaged again.
CREATE TABLE IF NOT EXISTS "campaign_sequences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "category" varchar(80) NOT NULL,
  "active" boolean DEFAULT false NOT NULL,
  -- After the last step, send it again every N days (30 = monthly); null = stop after the last step
  "repeat_every_days" integer DEFAULT 30,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_campaign_sequences_category" ON "campaign_sequences" ("tenant_id", lower("category"));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "campaign_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sequence_id" uuid NOT NULL REFERENCES "campaign_sequences"("id") ON DELETE CASCADE,
  -- Day 1 = the day they join
  "day" integer NOT NULL,
  "template_name" varchar(120) NOT NULL,
  "language" varchar(10) DEFAULT 'en' NOT NULL,
  -- Template body variables in order: name | company | category | subcategory
  "params" text[] DEFAULT '{}' NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_campaign_steps_sequence" ON "campaign_steps" ("sequence_id", "day");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "campaign_enrolments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "sequence_id" uuid NOT NULL REFERENCES "campaign_sequences"("id") ON DELETE CASCADE,
  -- lead | enquiry
  "kind" varchar(10) NOT NULL,
  "ref_id" uuid NOT NULL,
  "phone" varchar(20) NOT NULL,
  "name" varchar(160),
  "company" varchar(160),
  "category" varchar(80),
  "subcategory" varchar(80),
  -- active | paused | stopped
  "status" varchar(10) DEFAULT 'active' NOT NULL,
  -- replied | interested | demo | not_interested | opted_out | converted | lost | removed | manual | finished
  "stop_reason" varchar(20),
  "enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- How many steps were sent (0 = none yet); the next step is the one after
  "steps_sent" integer DEFAULT 0 NOT NULL,
  "next_send_at" timestamp with time zone,
  "last_sent_at" timestamp with time zone,
  "last_error" text,
  "stopped_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_campaign_enrolments_due" ON "campaign_enrolments" ("status", "next_send_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_campaign_enrolments_phone" ON "campaign_enrolments" ("tenant_id", "phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_campaign_enrolments_ref" ON "campaign_enrolments" ("ref_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "campaign_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "enrolment_id" uuid NOT NULL REFERENCES "campaign_enrolments"("id") ON DELETE CASCADE,
  "day" integer NOT NULL,
  "template_name" varchar(120) NOT NULL,
  -- sent | failed | reply
  "kind" varchar(10) NOT NULL,
  "text" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_campaign_messages_enrolment" ON "campaign_messages" ("enrolment_id", "created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "campaign_optouts" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "phone" varchar(20) NOT NULL,
  "reason" varchar(20) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("tenant_id", "phone")
);
