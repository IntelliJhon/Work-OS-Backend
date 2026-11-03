-- Migration: 0050_company_mail
-- Company email (e.g. info@intellijohn.com) per workspace: sent over SMTP, a copy saved to the mailbox's Sent folder
-- over IMAP, and every email logged (who sent what to whom, and for which lead). The password is encrypted.
-- No RLS: every query filters by tenant_id.
CREATE TABLE IF NOT EXISTS "tenant_mail_accounts" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "from_email" varchar(255) NOT NULL,
  "from_name" varchar(120),
  "smtp_host" varchar(255) NOT NULL,
  "smtp_port" integer NOT NULL,
  -- true = SSL from the start (465); false = STARTTLS (587)
  "smtp_secure" boolean DEFAULT true NOT NULL,
  -- Empty = no copy in the Sent folder
  "imap_host" varchar(255),
  "imap_port" integer DEFAULT 993 NOT NULL,
  "username" varchar(255) NOT NULL,
  "password_encrypted" text NOT NULL,
  "signature" text,
  "last_test_at" timestamp with time zone,
  "last_test_ok" boolean,
  "last_test_error" text,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "emails" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "lead_id" uuid REFERENCES "leads"("id") ON DELETE SET NULL,
  "sent_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "from_email" varchar(255) NOT NULL,
  "to" text[] NOT NULL,
  "cc" text[] DEFAULT '{}' NOT NULL,
  "subject" varchar(300) NOT NULL,
  "body" text NOT NULL,
  -- [{ name, uploadId? }]
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- sent | failed
  "status" varchar(10) NOT NULL,
  "error" text,
  "message_id" varchar(300),
  "saved_to_sent" boolean DEFAULT false NOT NULL,
  -- manual | ai
  "via" varchar(10) DEFAULT 'manual' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_emails_tenant" ON "emails" ("tenant_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_emails_lead" ON "emails" ("lead_id");
