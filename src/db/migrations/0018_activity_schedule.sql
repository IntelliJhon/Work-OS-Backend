-- Migration: 0018_activity_schedule
-- Adds frequency, start_date, end_date fields to activities table

ALTER TABLE "activities"
  ADD COLUMN IF NOT EXISTS "frequency" varchar(20),
  ADD COLUMN IF NOT EXISTS "start_date" timestamp,
  ADD COLUMN IF NOT EXISTS "end_date" timestamp;
