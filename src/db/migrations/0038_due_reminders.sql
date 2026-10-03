-- Migration: 0038_due_reminders
-- Reminders for bills, renewals, subscriptions, taxes… Each row is one occurrence; a repeating reminder gets its
-- next occurrence (same series_id) when this one is marked done. WhatsApp 1 day before the due date, then every
-- 12 hours (never at night) until done; Admins are told once when the due date has passed.
-- Proof files are in uploads (entity_type 'REMINDER', entity_id = the occurrence). No RLS: queries filter by tenant.
CREATE TABLE IF NOT EXISTS "due_reminders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "series_id" uuid NOT NULL,
  -- Responsible for it (gets the WhatsApp reminders)
  "owner_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "title" varchar(200) NOT NULL,
  "notes" text,
  -- bill | renewal | subscription | tax | other
  "category" varchar(20) DEFAULT 'bill' NOT NULL,
  "amount" numeric(12, 2),
  -- once | monthly | yearly | custom (every every_n every_unit)
  "repeat" varchar(10) NOT NULL,
  "every_n" smallint,
  -- day | week | month
  "every_unit" varchar(10),
  -- The first due date of the series (keeps "the 31st" stable across short months)
  "anchor_date" date NOT NULL,
  "due_date" date NOT NULL,
  -- active | done | cancelled
  "status" varchar(10) DEFAULT 'active' NOT NULL,
  "next_notify_at" timestamp with time zone,
  "last_notified_at" timestamp with time zone,
  "notify_count" integer DEFAULT 0 NOT NULL,
  "escalated_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "completed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "report" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_due_reminders_notify" ON "due_reminders" ("status", "next_notify_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_due_reminders_tenant_due" ON "due_reminders" ("tenant_id", "due_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_due_reminders_series" ON "due_reminders" ("tenant_id", "series_id");
