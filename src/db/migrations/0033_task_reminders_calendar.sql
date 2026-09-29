-- Migration: 0033_task_reminders_calendar
-- Work reminders and calendar feeds.
-- The due date/time stay in tasks.custom_fields (dueDate, dueTime, reminderMinutes: local to WORK_TIMEZONE, as
-- typed). These columns hold the derived moments, set by the app, so the reminder job can find due reminders.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "remind_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "reminder_sent_at" timestamp with time zone;--> statement-breakpoint

-- Reminders still to send
CREATE INDEX IF NOT EXISTS "idx_tasks_remind_at_pending" ON "tasks" ("remind_at") WHERE "reminder_sent_at" IS NULL;--> statement-breakpoint

-- Existing work with a due time (from voice notes). No reminder was chosen for it, so none is scheduled.
UPDATE "tasks"
SET "due_at" = ((custom_fields->>'dueDate') || ' ' || (custom_fields->>'dueTime'))::timestamp AT TIME ZONE 'Asia/Kolkata'
WHERE "due_at" IS NULL
  AND custom_fields->>'dueDate' ~ '^\d{4}-\d{2}-\d{2}$'
  AND custom_fields->>'dueTime' ~ '^([01]\d|2[0-3]):[0-5]\d$';--> statement-breakpoint

-- One private calendar link per user (subscribed from Google Calendar / Outlook / iPhone).
-- Looked up by the token's hash from a public URL, before any tenant is known, so no RLS; the feed itself
-- reads tasks inside the user's tenant. The token is kept encrypted so the user can see their link again.
CREATE TABLE IF NOT EXISTS "calendar_feeds" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "token_hash" varchar(64) NOT NULL,
  "token_encrypted" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "calendar_feeds_token_hash_unique" UNIQUE ("token_hash")
);
