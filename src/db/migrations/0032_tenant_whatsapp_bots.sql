-- Migration: 0032_tenant_whatsapp_bots
-- A workspace can use its own WhatsApp bot (WAAU channel) instead of the platform's default one.
-- Managed only by platform admins. The access token is stored encrypted (AES-256-GCM, key in env).
CREATE TABLE IF NOT EXISTS "tenant_whatsapp_bots" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- Meta/WAAU phone number ID of the channel. Also the bot ID n8n passes (?bot=...), so it is unique.
  "phone_number_id" varchar(64) NOT NULL,
  "access_token_encrypted" text NOT NULL,
  -- The channel's WhatsApp number, shown to senders (e.g. "send your work to +91 …")
  "business_phone" varchar(20),
  -- Template names in that channel's WhatsApp account (NULL = platform defaults from env)
  "otp_template" varchar(100),
  "owner_template" varchar(100),
  "employee_template" varchar(100),
  "template_lang" varchar(10),
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "tenant_whatsapp_bots_phone_number_id_unique" UNIQUE ("phone_number_id")
);
