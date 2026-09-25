-- Migration: 0031_voice_note_confirmation
-- Every voice/typed note is confirmed by the sender on WhatsApp before a task is created.

-- 'awaiting_confirmation': the bot sent "Here's what I understood… 1 Create / 2 Change / 3 Cancel"
-- (21 characters, so the column is widened first)
ALTER TABLE "voice_notes" ALTER COLUMN "status" TYPE varchar(30);
--> statement-breakpoint
ALTER TABLE "voice_notes" DROP CONSTRAINT IF EXISTS "voice_notes_status_check";
--> statement-breakpoint
ALTER TABLE "voice_notes" ADD CONSTRAINT "voice_notes_status_check"
  CHECK ("status" IN ('new', 'converted', 'dismissed', 'unclear', 'awaiting_assignee', 'awaiting_confirmation'));
--> statement-breakpoint

-- The member the task will be assigned to once confirmed
ALTER TABLE "voice_notes" ADD COLUMN IF NOT EXISTS "proposed_assignee_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- Other people in the note: who checks the work, and who should just be informed (names as understood)
ALTER TABLE "voice_notes" ADD COLUMN IF NOT EXISTS "reviewer_name" varchar(150);
--> statement-breakpoint
ALTER TABLE "voice_notes" ADD COLUMN IF NOT EXISTS "informed_names" jsonb;
--> statement-breakpoint
-- 'instruction' (new work) or 'report' (an update about something already done)
ALTER TABLE "voice_notes" ADD COLUMN IF NOT EXISTS "note_kind" varchar(20);
