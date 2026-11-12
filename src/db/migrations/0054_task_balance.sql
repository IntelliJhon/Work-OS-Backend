-- Migration: 0054_task_balance
-- WAAU automation task balance (Task Allotted / Consumed / Remaining) of watched clients, read once a day, and
-- WhatsApp alerts when it runs low. task_balance_watch = the clients (Partner Panel account ids) that are watched.
-- client_task_balance = the last reading per client. task_low_alerts = one row per low client: the first alert, then
-- one reminder the next day, then none until tasks are added again (the row is cleared once it is above the limit).
CREATE TABLE IF NOT EXISTS "task_balance_watch" (
  "user_id" varchar(64) PRIMARY KEY,
  "name" varchar(255) NOT NULL,
  "added_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "client_task_balance" (
  "user_id" varchar(64) PRIMARY KEY,
  "name" varchar(255),
  "total" integer,
  "consumed" integer,
  "remaining" integer,
  -- Last successful reading
  "checked_at" timestamp with time zone,
  -- Last failed attempt (cleared by the next successful one)
  "error" text,
  "error_at" timestamp with time zone
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "task_low_alerts" (
  "user_id" varchar(64) PRIMARY KEY,
  "name" varchar(255) NOT NULL,
  "remaining" integer NOT NULL,
  -- 1 = first alert sent, 2 = next-day reminder sent (no more until tasks are added)
  "alert_count" integer DEFAULT 1 NOT NULL,
  "alerted_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- The same clients as the conversation-wallet alerts, plus Focuz (telemarketing@focuzauto.com), chosen on 12 Nov 2026
INSERT INTO "task_balance_watch" ("user_id", "name") VALUES
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
  ('68c90ab1af7a453aceb2c07c', 'Artic Bath India Pvt. Ltd'),
  ('68c1065c74ed1cad7dbe74ff', 'Focuz (telemarketing@focuzauto.com)')
ON CONFLICT ("user_id") DO NOTHING;
