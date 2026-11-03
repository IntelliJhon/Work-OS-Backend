-- Migration: 0047_lead_automation
-- Leads, phase 2: the proposal goes to the client on WhatsApp, owners get WhatsApp follow-up reminders, and an
-- accepted lead becomes a Client (bot clients are added in the Partner admin panel instead).
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "client_id" uuid REFERENCES "workspace_clients"("id") ON DELETE SET NULL;--> statement-breakpoint
-- bot (added in the Partner admin panel) | client (added to Clients)
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "accepted_as" varchar(10);--> statement-breakpoint
-- The follow-up time the owner was last reminded of, and last told was overdue (a new follow-up time reminds again)
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "follow_up_reminded_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "follow_up_overdue_for" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_leads_follow_up" ON "leads" ("next_follow_up_at") WHERE "archived_at" IS NULL AND "next_follow_up_at" IS NOT NULL;--> statement-breakpoint

-- When this version was sent to the client on WhatsApp, or why it could not be
ALTER TABLE "lead_proposals" ADD COLUMN IF NOT EXISTS "whatsapp_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lead_proposals" ADD COLUMN IF NOT EXISTS "whatsapp_error" text;
