-- Migration: 0039_task_assigned_by
-- Who assigned a task (the creator, or whoever last gave it to someone else). Told when the task is done.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "assigned_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Existing tasks: the person who created them, from the security log (tasks and audit_log use row-level
-- security, so go workspace by workspace)
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant_id', t.id::text, true);
    UPDATE tasks k
    SET assigned_by = (
      SELECT a.user_id FROM audit_log a
      WHERE a.tenant_id = k.tenant_id AND a.table_name = 'tasks' AND a.action = 'INSERT' AND a.record_id = k.id
      ORDER BY a.created_at
      LIMIT 1
    )
    WHERE k.tenant_id = t.id AND k.assigned_by IS NULL;
  END LOOP;
END $$;
