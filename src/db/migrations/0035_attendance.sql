-- Migration: 0035_attendance
-- Daily attendance: the first check-in of the day decides Present (Early before 09:30) / Late (after 09:35);
-- no check-in by 12:00 = Absent. Days and times are local to WORK_TIMEZONE (Asia/Kolkata).
CREATE TABLE IF NOT EXISTS "attendance_settings" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT true NOT NULL,
  "early_before" varchar(5) DEFAULT '09:30' NOT NULL,
  "late_after" varchar(5) DEFAULT '09:35' NOT NULL,
  "check_in_from" varchar(5) DEFAULT '07:00' NOT NULL,
  "absent_after" varchar(5) DEFAULT '12:00' NOT NULL,
  -- ISO weekdays: 1 = Monday … 7 = Sunday
  "working_days" smallint[] DEFAULT '{1,2,3,4,5,6}' NOT NULL,
  -- Days before this are never counted as absent
  "started_on" date DEFAULT CURRENT_DATE NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "attendance_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  -- present | late | absent | leave
  "status" varchar(20) NOT NULL,
  "early" boolean DEFAULT false NOT NULL,
  "check_in_at" timestamp with time zone,
  "latitude" double precision,
  "longitude" double precision,
  "accuracy_m" real,
  -- ok | denied | unavailable (null for entries made by an admin)
  "location_status" varchar(20),
  "note" text,
  "corrected_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "corrected_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "attendance_records_tenant_user_day_unique" UNIQUE ("tenant_id", "user_id", "day")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_attendance_records_tenant_day" ON "attendance_records" ("tenant_id", "day");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "attendance_holidays" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  "name" varchar(120) NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("tenant_id", "day")
);--> statement-breakpoint

-- Every existing workspace starts counting attendance the day after this migration (India date), so a
-- deploy during the day doesn't mark everyone who opens Work OS that afternoon as absent
INSERT INTO "attendance_settings" ("tenant_id", "started_on")
SELECT "id", (now() AT TIME ZONE 'Asia/Kolkata')::date + 1 FROM "tenants"
ON CONFLICT ("tenant_id") DO NOTHING;--> statement-breakpoint

-- Project Managers can see everyone's attendance (correcting it stays admin-only)
UPDATE "roles"
SET permissions = permissions || '{"attendance.read": true}'::jsonb
WHERE name = 'Project Manager';
