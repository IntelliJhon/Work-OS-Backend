-- Migration: 0053_billing
-- Billing section (LeadsNDeals): Onboarded Clients linked to Zoho Books customers, and payments received from them.
-- Each payment is recorded in Zoho Books as a customer payment; its receipt PDF is kept and sent to the client on
-- WhatsApp after someone approves it.
CREATE TABLE IF NOT EXISTS "billing_customers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- Partner Panel account id (Onboarded Clients)
  "client_id" varchar(64) NOT NULL,
  "client_name" varchar(255) NOT NULL,
  "zoho_customer_id" varchar(32),
  -- Where receipts and invoices go on WhatsApp (with country code)
  "whatsapp" varchar(20),
  "gstin" varchar(15),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_billing_customers_tenant_client" ON "billing_customers" ("tenant_id", "client_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "billing_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "client_id" varchar(64) NOT NULL,
  "client_name" varchar(255) NOT NULL,
  "amount" numeric(12, 2) NOT NULL,
  "paid_on" date NOT NULL,
  -- upi | bank_transfer | cash | cheque | other
  "mode" varchar(20) NOT NULL,
  "reference" varchar(100),
  "note" text,
  "zoho_payment_id" varchar(32),
  "zoho_payment_number" varchar(50),
  "receipt_upload_id" uuid REFERENCES "uploads"("id") ON DELETE SET NULL,
  -- pending (waiting for Send) | sent | failed | skipped
  "receipt_status" varchar(10) DEFAULT 'pending' NOT NULL,
  "whatsapp_to" varchar(20),
  "whatsapp_error" text,
  "receipt_sent_at" timestamp with time zone,
  "recorded_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "sent_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_payments_tenant_created" ON "billing_payments" ("tenant_id", "created_at");--> statement-breakpoint
-- The same bank reference is never recorded twice for a client
CREATE UNIQUE INDEX IF NOT EXISTS "uq_billing_payments_reference" ON "billing_payments" ("tenant_id", "client_id", "reference") WHERE "reference" IS NOT NULL;
