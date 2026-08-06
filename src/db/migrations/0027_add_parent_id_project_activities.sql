ALTER TABLE "project_activities" ADD COLUMN IF NOT EXISTS "parent_id" uuid REFERENCES "project_activities"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_activities_parent_id" ON "project_activities" ("parent_id");


