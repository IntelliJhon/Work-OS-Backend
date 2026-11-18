-- Migration: 0055_client_categories
-- Client categorization on Onboarding Clients and the Enquiry List: category (e.g. Healthcare), subcategory
-- (e.g. Clinic), whether the client already uses software (null = not asked) and which one.
ALTER TABLE "client_onboarding" ADD COLUMN IF NOT EXISTS "category" varchar(80);--> statement-breakpoint
ALTER TABLE "client_onboarding" ADD COLUMN IF NOT EXISTS "subcategory" varchar(80);--> statement-breakpoint
ALTER TABLE "client_onboarding" ADD COLUMN IF NOT EXISTS "uses_software" boolean;--> statement-breakpoint
ALTER TABLE "client_onboarding" ADD COLUMN IF NOT EXISTS "software_name" varchar(120);--> statement-breakpoint
ALTER TABLE "client_enquiries" ADD COLUMN IF NOT EXISTS "category" varchar(80);--> statement-breakpoint
ALTER TABLE "client_enquiries" ADD COLUMN IF NOT EXISTS "subcategory" varchar(80);--> statement-breakpoint
ALTER TABLE "client_enquiries" ADD COLUMN IF NOT EXISTS "uses_software" boolean;--> statement-breakpoint
ALTER TABLE "client_enquiries" ADD COLUMN IF NOT EXISTS "software_name" varchar(120);
