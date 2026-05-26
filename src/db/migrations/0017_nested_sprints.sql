-- Rename sprints to activities
ALTER TABLE "sprints" RENAME TO "activities";--> statement-breakpoint

-- Rename column name to title
ALTER TABLE "activities" RENAME COLUMN "name" TO "title";--> statement-breakpoint

-- Add is_sprint_relevant column
ALTER TABLE "activities" ADD COLUMN "is_sprint_relevant" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- Populate is_sprint_relevant for historical sprint activities
UPDATE "activities" SET "is_sprint_relevant" = true WHERE "type" = 'sprint';--> statement-breakpoint

-- Create the new sprints table
CREATE TABLE IF NOT EXISTS "sprints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "activity_id" uuid NOT NULL REFERENCES "activities"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "name" varchar(255) NOT NULL,
  "status" "sprint_status" NOT NULL DEFAULT 'planning',
  "start_date" timestamp,
  "end_date" timestamp,
  "cadence_type" varchar(50),
  "cadence_interval" integer,
  "goal" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "deleted_at" timestamp
);--> statement-breakpoint

-- Populate nested sprints table from sprint-relevant activities to maintain backward compatibility
INSERT INTO "sprints" ("id", "activity_id", "project_id", "tenant_id", "name", "status", "start_date", "end_date", "cadence_type", "cadence_interval", "created_at", "updated_at", "deleted_at")
SELECT "id", "id", "project_id", "tenant_id", "title", "status", "start_date", "end_date", "cadence_type", "cadence_interval", "created_at", "updated_at", "deleted_at"
FROM "activities"
WHERE "is_sprint_relevant" = true;--> statement-breakpoint

-- Drop columns from activities that belong to nested sprints
ALTER TABLE "activities" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "start_date";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "end_date";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "cadence_type";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "cadence_interval";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "type";--> statement-breakpoint

-- Create indices on sprints
CREATE INDEX IF NOT EXISTS "idx_sprints_activity_id" ON "sprints"("activity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sprints_project_id" ON "sprints"("project_id");--> statement-breakpoint

-- Update tasks table: add activity_id column
ALTER TABLE "tasks" ADD COLUMN "activity_id" uuid;--> statement-breakpoint

-- Map tasks activity_id to match their original sprint ID (since sprints became activities)
UPDATE "tasks" SET "activity_id" = "sprint_id" WHERE "sprint_id" IS NOT NULL;--> statement-breakpoint

-- If standard activities were previously using sprint_id, set sprint_id = NULL for them
UPDATE "tasks" SET "sprint_id" = NULL WHERE "sprint_id" IN (SELECT "id" FROM "activities" WHERE "is_sprint_relevant" = false);--> statement-breakpoint

-- Drop the old constraint pointing tasks.sprint_id to activities (since the sprints table was renamed to activities)
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_sprint_id_sprints_id_fk";--> statement-breakpoint

-- Add new constraint pointing tasks.sprint_id to nested sprints table
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "sprints"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Add constraint for activity_id pointing to activities table
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE CASCADE;--> statement-breakpoint

-- Create index on tasks activity_id
CREATE INDEX IF NOT EXISTS "idx_tasks_activity_id" ON "tasks"("activity_id");--> statement-breakpoint

-- Drop and recreate RLS policies to align with table renames and creations
DROP POLICY IF EXISTS tenant_isolation_policy ON "activities";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation_policy ON "sprints";--> statement-breakpoint

ALTER TABLE "activities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sprints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation_policy ON "activities"
    AS PERMISSIVE FOR ALL
    USING (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);--> statement-breakpoint

CREATE POLICY tenant_isolation_policy ON "sprints"
    AS PERMISSIVE FOR ALL
    USING (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);--> statement-breakpoint

-- Re-apply constraints
ALTER TABLE "sprints" ADD CONSTRAINT "chk_sprints_status" CHECK (status IN ('planning', 'active', 'closed', 'cancelled'));
