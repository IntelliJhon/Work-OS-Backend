-- Migration: 0043_project_clients_time_logs
-- 1. Projects belong to a client from the Clients section (client_id), or to the workspace itself:
--    "Company Projects" = client_id NULL with client_name 'Company Projects'. client_name keeps the name shown.
-- 2. Time logs: the person a project task is assigned to logs the time they worked on it each day (until it is
--    done). Every entry is also a work report of that person (employee_work_reports), kept in step with it.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "client_id" uuid REFERENCES "workspace_clients"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_client" ON "projects" ("client_id");--> statement-breakpoint
-- Link existing projects whose typed client name matches a client
UPDATE "projects" p SET "client_id" = c."id", "client_name" = c."name"
FROM "workspace_clients" c
WHERE p."client_id" IS NULL AND c."tenant_id" = p."tenant_id" AND c."archived_at" IS NULL
  AND p."client_name" IS NOT NULL AND lower(trim(p."client_name")) = lower(c."name");--> statement-breakpoint

ALTER TABLE "employee_work_reports" ADD COLUMN IF NOT EXISTS "work_date" date;--> statement-breakpoint
ALTER TABLE "employee_work_reports" ADD COLUMN IF NOT EXISTS "minutes" integer;--> statement-breakpoint
ALTER TABLE "employee_work_reports" ADD COLUMN IF NOT EXISTS "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "employee_work_reports" ADD COLUMN IF NOT EXISTS "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_work_reports_employee_day" ON "employee_work_reports" ("tenant_id", "employee_id", "work_date");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "task_time_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- The day the work was done (workspace's local date)
  "work_date" date NOT NULL,
  "minutes" integer NOT NULL CHECK ("minutes" BETWEEN 1 AND 1440),
  -- What was done
  "note" text NOT NULL,
  -- The matching work report in the Employees section
  "work_report_id" uuid REFERENCES "employee_work_reports"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_time_logs_user_day" ON "task_time_logs" ("tenant_id", "user_id", "work_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_time_logs_task" ON "task_time_logs" ("task_id");--> statement-breakpoint

-- The 6 pm "log your time" reminder is sent once per person per day
CREATE TABLE IF NOT EXISTS "time_log_reminders" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "work_date" date NOT NULL,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "work_date")
);
