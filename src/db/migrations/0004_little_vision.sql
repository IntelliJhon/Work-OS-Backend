ALTER TABLE "tenants" ADD COLUMN "slug" varchar(255);--> statement-breakpoint
UPDATE "tenants" SET "slug" = "id"::varchar;--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "plan" varchar(50) DEFAULT 'starter' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "two_fa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_slug_unique" UNIQUE("slug");