ALTER TABLE "phases" DROP CONSTRAINT IF EXISTS "chk_phases_status", ADD CONSTRAINT "chk_phases_status" CHECK (status IN ('pending', 'active', 'completed', 'blocked'));
