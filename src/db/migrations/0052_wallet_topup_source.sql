-- Where a wallet top-up was made from: the Add balance buttons or the Ask AI assistant
ALTER TABLE "wallet_topups" ADD COLUMN IF NOT EXISTS "source" varchar(10) DEFAULT 'button' NOT NULL;
--> statement-breakpoint
UPDATE "wallet_topups" SET "source" = 'ai' WHERE "note" = 'Added from Ask AI';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wallet_topups_tenant_created" ON "wallet_topups" ("tenant_id", "created_at");
