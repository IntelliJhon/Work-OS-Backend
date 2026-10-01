-- Migration: 0037_sections_platform_admins
-- 1. Platform admins are specific user accounts, not "any account with this email" (signup doesn't verify email,
--    so anyone could register a workspace with an admin's address). Seeded with the accounts that use the current
--    platform admin's email today.
CREATE TABLE IF NOT EXISTS "platform_admins" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- users has FORCE row-level security: read it workspace by workspace
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant_id', t.id::text, true);
    INSERT INTO platform_admins (user_id)
    SELECT id FROM users WHERE tenant_id = t.id AND deleted_at IS NULL AND lower(email) = 'akashks304@gmail.com'
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;--> statement-breakpoint

-- 2. Sections a platform admin switched on or off for a workspace ({"leave": false, …}); missing = the default
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "sections" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint

-- 3. Using Attendance and applying for Leave become role permissions (everyone keeps them today)
UPDATE "roles"
SET permissions = permissions || '{"attendance.use": true, "leave.use": true}'::jsonb;
