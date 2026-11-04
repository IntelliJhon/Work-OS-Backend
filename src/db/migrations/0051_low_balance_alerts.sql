-- Migration: 0051_low_balance_alerts
-- WhatsApp alerts when a watched client's WhatsApp channel (Partner Panel) has less than the limit in its conversation
-- wallet. low_balance_watch = the clients (Partner Panel account ids) that are watched, switched on and off on the
-- Onboarded Clients page. low_balance_alerts = one row per low channel: how many alerts it got (the first, then one
-- reminder the next day, then none) and when; the row is cleared once the client tops up.
CREATE TABLE IF NOT EXISTS "low_balance_watch" (
  "user_id" varchar(64) PRIMARY KEY,
  "name" varchar(255) NOT NULL,
  "added_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "low_balance_alerts" (
  "channel_id" varchar(64) PRIMARY KEY,
  "user_id" varchar(64),
  "name" varchar(255) NOT NULL,
  "number" varchar(32),
  "balance" numeric(12, 3) NOT NULL,
  -- 1 = first alert sent, 2 = next-day reminder sent (no more until a top-up)
  "alert_count" integer DEFAULT 1 NOT NULL,
  "alerted_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- The clients chosen on 4 Nov 2026
INSERT INTO "low_balance_watch" ("user_id", "name") VALUES
  ('6ab6206ad2af331da449e7bb', 'NYL Healing'),
  ('6ac0d4d0d2af331da4748f7b', 'TRUST WHEELS'),
  ('68b2c9fdc9b8c53d3977cea9', 'Surabhi Innovation'),
  ('6ad98d00662b099e704f02c2', 'CLEOSPORTZ SPORTZ'),
  ('6958c56440742fadf06c121b', 'Industrial Partners Link Connect'),
  ('6944c1c4d03de96ddc118f5c', 'Perfect Hands Solutions'),
  ('692a966542ecfbb0d51ea37d', 'IMA COCHIN CHARITABLE SOCIETY'),
  ('6929917742ecfbb0d51c0c30', 'Focuz biwheelers'),
  ('69201c1b7c673b1b53ddef3c', 'KOZHIKODE CITY POLICE EMPLOYEES CO OP SOCIETY'),
  ('687f6cac25a7e6825d14ebd5', 'White and Co Real Estate'),
  ('689d7a28c1b386ccd32d1d98', 'THE KANJIRAPALLY PRIMARY CO OPERATIVE AGRICULTURAL AND RURAL DEVELOPMENT BANK K1120'),
  ('68a2ca1f10e8c5c0c027bf7e', 'idukki police co-operative society'),
  ('68a6afed8ccfa14c35c71c28', 'Dtpc LLP'),
  ('68b15dc6866c439f62a81a05', 'KTTC'),
  ('68c90ab1af7a453aceb2c07c', 'Artic Bath India Pvt. Ltd')
ON CONFLICT ("user_id") DO NOTHING;
--> statement-breakpoint

-- Balance added from Work OS (Admins only), to a client's main wallet or to one WhatsApp channel's conversation wallet
CREATE TABLE IF NOT EXISTS "wallet_topups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- Partner Panel account id, and the channel for a conversation wallet
  "client_id" varchar(64) NOT NULL,
  "client_name" varchar(255),
  "channel_id" varchar(64),
  "channel_number" varchar(32),
  -- main | conversation
  "wallet" varchar(15) NOT NULL,
  "amount" numeric(12, 2) NOT NULL,
  "note" text,
  -- done | failed
  "status" varchar(10) NOT NULL,
  "error" text,
  "added_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wallet_topups_client" ON "wallet_topups" ("client_id", "created_at");
