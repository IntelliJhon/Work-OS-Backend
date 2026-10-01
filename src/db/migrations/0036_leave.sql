-- Migration: 0036_leave
-- Leave requests: an employee's request goes to the person they report to (or any Project Manager), then to an
-- Admin; a Project Manager's request goes straight to an Admin; an Admin's to another Admin. Approved leave is
-- written to attendance_records as 'leave' days. No RLS: every query filters by tenant_id.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "reports_to" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "leave_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "from_day" date NOT NULL,
  "to_day" date NOT NULL,
  -- first | second (a single day only); null = full days
  "half_day" varchar(10),
  "reason" text NOT NULL,
  -- pending_manager | pending_admin | approved | rejected | cancelled
  "status" varchar(20) NOT NULL,
  -- Working days asked for (0.5 for a half day), counted when applied
  "days" real NOT NULL,
  -- Who decides the first step: the person the applicant reports to; null = any Project Manager
  "manager_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "manager_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "manager_at" timestamp with time zone,
  "manager_comment" text,
  "admin_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "admin_at" timestamp with time zone,
  "admin_comment" text,
  -- Moved to the Admins because the manager didn't act in time
  "escalated_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_leave_requests_tenant_status" ON "leave_requests" ("tenant_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_leave_requests_tenant_user" ON "leave_requests" ("tenant_id", "user_id");--> statement-breakpoint

-- A half day of leave keeps the day's check-in; leave written by an approved request points to it
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "leave_half" varchar(10);--> statement-breakpoint
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "leave_request_id" uuid REFERENCES "leave_requests"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Project Managers approve their team's leave (the final approval stays with Admins)
UPDATE "roles"
SET permissions = permissions || '{"leave.approve": true}'::jsonb
WHERE name = 'Project Manager';
