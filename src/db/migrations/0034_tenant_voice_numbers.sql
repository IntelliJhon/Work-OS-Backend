-- Migration: 0034_tenant_voice_numbers
-- A workspace can have several verified WhatsApp numbers that send voice notes / typed work (owner, managers).
-- A number belongs to one workspace only (primary key). Looked up by phone before any tenant is known, so no RLS.
-- user_id: the member whose number it is (the "from" of the work); verified_by: who verified it.
-- tenants.voice_phone* keeps only the OTP of a verification in progress; its verified number columns are legacy.
CREATE TABLE IF NOT EXISTS "tenant_voice_numbers" (
  "phone" varchar(20) PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "verified_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "verified_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tenant_voice_numbers_tenant_id" ON "tenant_voice_numbers" ("tenant_id");--> statement-breakpoint

-- Each workspace's current number
INSERT INTO "tenant_voice_numbers" ("phone", "tenant_id", "user_id", "verified_by", "verified_at")
SELECT "voice_phone", "id", "voice_phone_user_id", "voice_phone_user_id", "voice_phone_verified_at"
FROM "tenants"
WHERE "voice_phone" IS NOT NULL AND "voice_phone_verified_at" IS NOT NULL
ON CONFLICT ("phone") DO NOTHING;
