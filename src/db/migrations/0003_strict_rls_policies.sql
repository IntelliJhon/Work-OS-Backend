-- Enable Row Level Security
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "phases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sprints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "epics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Drop old permissive policies
DROP POLICY IF EXISTS tenant_isolation_policy ON "roles";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_policy ON "users";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_policy ON "projects";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_policy ON "phases";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_policy ON "sprints";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_policy ON "epics";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_policy ON "stories";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_policy ON "tasks";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_policy ON "audit_log";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_policy ON "refresh_tokens";--> statement-breakpoint

-- Create new strict policies with USING and WITH CHECK
CREATE POLICY tenant_isolation_policy ON "roles"
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);--> statement-breakpoint

CREATE POLICY tenant_isolation_policy ON "users"
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);--> statement-breakpoint

CREATE POLICY tenant_isolation_policy ON "projects"
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);--> statement-breakpoint

CREATE POLICY tenant_isolation_policy ON "phases"
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);--> statement-breakpoint

CREATE POLICY tenant_isolation_policy ON "sprints"
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);--> statement-breakpoint

CREATE POLICY tenant_isolation_policy ON "epics"
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);--> statement-breakpoint

CREATE POLICY tenant_isolation_policy ON "stories"
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);--> statement-breakpoint

CREATE POLICY tenant_isolation_policy ON "tasks"
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);--> statement-breakpoint

CREATE POLICY tenant_isolation_policy ON "audit_log"
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);--> statement-breakpoint

CREATE POLICY tenant_isolation_policy ON "refresh_tokens"
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);--> statement-breakpoint

-- Check Constraints
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_projects_status') THEN
    ALTER TABLE "projects" ADD CONSTRAINT "chk_projects_status" CHECK (status IN ('active', 'on_hold', 'completed', 'archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_phases_status') THEN
    ALTER TABLE "phases" ADD CONSTRAINT "chk_phases_status" CHECK (status IN ('pending', 'active', 'completed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sprints_status') THEN
    ALTER TABLE "sprints" ADD CONSTRAINT "chk_sprints_status" CHECK (status IN ('planning', 'active', 'closed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_epics_status') THEN
    ALTER TABLE "epics" ADD CONSTRAINT "chk_epics_status" CHECK (status IN ('to_do', 'todo', 'in_progress', 'done'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_stories_status') THEN
    ALTER TABLE "stories" ADD CONSTRAINT "chk_stories_status" CHECK (status IN ('to_do', 'todo', 'in_progress', 'done'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_tasks_status') THEN
    ALTER TABLE "tasks" ADD CONSTRAINT "chk_tasks_status" CHECK (status IN ('to_do', 'todo', 'in_progress', 'review', 'done'));
  END IF;
END $$;