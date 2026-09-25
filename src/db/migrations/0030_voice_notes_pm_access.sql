-- Migration: 0030_voice_notes_pm_access
-- Project Managers can see and process the voice notes inbox (managing the WhatsApp number stays admin-only).
-- Admins can still switch these off per role in Settings -> Roles & Permissions.
UPDATE "roles"
SET permissions = permissions || '{"voice_notes.read": true, "voice_notes.update": true}'::jsonb
WHERE name = 'Project Manager';
--> statement-breakpoint

-- Voice notes whose task was deleted (the FK cleared task_id) go to Dismissed,
-- matching what now happens when such a task is deleted.
UPDATE "voice_notes"
SET status = 'dismissed', assignee_candidates = NULL, updated_at = now()
WHERE status = 'converted' AND task_id IS NULL;
