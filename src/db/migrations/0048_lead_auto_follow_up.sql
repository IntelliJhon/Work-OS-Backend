-- Migration: 0048_lead_auto_follow_up
-- Automatic WhatsApp follow-ups to a lead whose proposal is unanswered, sent at each follow-up time (up to 3 per
-- proposal; a new proposal version starts again). auto_follow_up turns it off for one lead.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "auto_follow_up" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Automatic follow-ups sent for the current proposal
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "auto_follow_ups_sent" integer DEFAULT 0 NOT NULL;
