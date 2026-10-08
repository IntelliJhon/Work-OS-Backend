-- Migration: 0044_attendance_location_name
-- The place name of a check-in's location (e.g. "Kakkanad, Kochi"), looked up from OpenStreetMap after the check-in.
-- NULL = not looked up yet; '' = looked up, no name found (not tried again).
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "location_name" varchar(200);
