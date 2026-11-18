-- Migration: 0056_lead_categories
-- Leads get a category and subcategory (same as Onboarding Clients / Enquiries); when a lead is accepted they are
-- copied to the Client, so Clients get a subcategory too (they already had a category).
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "category" varchar(80);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "subcategory" varchar(80);--> statement-breakpoint
ALTER TABLE "workspace_clients" ADD COLUMN IF NOT EXISTS "subcategory" varchar(80);
