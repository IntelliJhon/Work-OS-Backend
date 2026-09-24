-- Migration: 0029_voice_task_assignment
-- Voice notes become assigned work: member WhatsApp numbers, per-workspace work numbers (W-1, W-2, ...),
-- and the extra voice note fields needed to create the task and ask for a missing assignee.

-- Member WhatsApp numbers (digits-only international format, set by an admin)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" varchar(20);
--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "phone" varchar(20);
--> statement-breakpoint

-- Per-workspace sequential work numbers
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "next_task_number" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "task_number" integer;
--> statement-breakpoint

-- Backfill existing tasks in creation order. Must run before the trigger below exists,
-- because the trigger keeps task_number unchanged on UPDATE.
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS n
  FROM "tasks"
  WHERE task_number IS NULL
)
UPDATE "tasks" t SET task_number = numbered.n FROM numbered WHERE t.id = numbered.id;
--> statement-breakpoint
UPDATE "tenants" SET next_task_number = COALESCE(
  (SELECT MAX(task_number) FROM "tasks" WHERE "tasks".tenant_id = "tenants".id), 0
) + 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_tenant_task_number_unique" ON "tasks" ("tenant_id", "task_number");
--> statement-breakpoint

-- Numbers are always assigned by the database (never taken from the client) and never change.
-- SECURITY DEFINER so the counter update works for the API role; the tenant row lock serializes concurrent inserts.
CREATE OR REPLACE FUNCTION assign_task_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE tenants SET next_task_number = next_task_number + 1
    WHERE id = NEW.tenant_id
    RETURNING next_task_number - 1 INTO NEW.task_number;
  ELSE
    NEW.task_number := OLD.task_number;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tasks_task_number" ON "tasks";
--> statement-breakpoint
CREATE TRIGGER "trg_tasks_task_number" BEFORE INSERT OR UPDATE OF task_number ON "tasks"
FOR EACH ROW EXECUTE FUNCTION assign_task_number();
--> statement-breakpoint

-- Voice notes: what Gemini extracted, and a status for notes waiting for the owner to name the employee
ALTER TABLE "voice_notes" ADD COLUMN IF NOT EXISTS "assignee_name" varchar(150);
--> statement-breakpoint
ALTER TABLE "voice_notes" ADD COLUMN IF NOT EXISTS "task_title" varchar(255);
--> statement-breakpoint
ALTER TABLE "voice_notes" ADD COLUMN IF NOT EXISTS "due_date" varchar(10);
--> statement-breakpoint
ALTER TABLE "voice_notes" ADD COLUMN IF NOT EXISTS "due_time" varchar(5);
--> statement-breakpoint
-- Numbered choices last offered to the owner ("Reply 1 or 2"): [{ "id": "<user id>", "name": "..." }]
ALTER TABLE "voice_notes" ADD COLUMN IF NOT EXISTS "assignee_candidates" jsonb;
--> statement-breakpoint
ALTER TABLE "voice_notes" DROP CONSTRAINT IF EXISTS "voice_notes_status_check";
--> statement-breakpoint
ALTER TABLE "voice_notes" ADD CONSTRAINT "voice_notes_status_check"
  CHECK ("status" IN ('new', 'converted', 'dismissed', 'unclear', 'awaiting_assignee'));
