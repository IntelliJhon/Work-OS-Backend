ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "chk_tasks_status", ADD CONSTRAINT "chk_tasks_status" CHECK (status IN ('to_do', 'todo', 'in_progress', 'in_review', 'review', 'done', 'blocked'));
