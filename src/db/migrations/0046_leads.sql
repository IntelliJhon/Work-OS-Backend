-- Migration: 0046_leads
-- Leads: enquiries a workspace is trying to win, moved through stages on a board
-- (new → contacted → requirement → proposal → follow_up → accepted / rejected). Proposals are versioned, each with
-- its file in uploads (entity_type 'LEAD', entity_id = lead). Notes and changes are in lead_activity.
-- No RLS: every query filters by tenant_id.
CREATE TABLE IF NOT EXISTS "leads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" varchar(120) NOT NULL,
  "company" varchar(160),
  -- WhatsApp number, digits with country code
  "phone" varchar(20) NOT NULL,
  "email" varchar(255),
  "city" varchar(80),
  -- manual | whatsapp | website | referral | call | walk_in | social | other
  "source" varchar(20) DEFAULT 'manual' NOT NULL,
  -- What they are interested in, e.g. "WhatsApp bot", "Website"
  "service" varchar(120),
  "expected_value" numeric(12, 2),
  -- new | contacted | requirement | proposal | follow_up | accepted | rejected
  "stage" varchar(20) DEFAULT 'new' NOT NULL,
  "stage_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "owner_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "next_follow_up_at" timestamp with time zone,
  "notes" text,
  -- Collected requirement
  "requirement" text,
  "budget" varchar(80),
  "timeline" varchar(80),
  -- price | timing | competitor | no_response | not_needed | other
  "reject_reason" varchar(20),
  "reject_note" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_leads_tenant_stage" ON "leads" ("tenant_id", "stage");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_leads_tenant_phone" ON "leads" ("tenant_id", "phone");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lead_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "lead_id" uuid NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  -- 1, 2, 3… per lead
  "version" integer NOT NULL,
  "amount" numeric(12, 2),
  "upload_id" uuid REFERENCES "uploads"("id") ON DELETE SET NULL,
  "note" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lead_proposals_lead" ON "lead_proposals" ("lead_id", "version");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lead_activity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "lead_id" uuid NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "actor_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  -- note | created | updated | stage | proposal | archived | restored
  "kind" varchar(20) NOT NULL,
  "body" text,
  -- Changed fields { field: [before, after] }, the stage move { from, to }, or the proposal { version, amount }
  "meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lead_activity_lead" ON "lead_activity" ("lead_id", "created_at");--> statement-breakpoint

-- Admins (always) and Project Managers work on leads; other roles get it from Settings → Roles
UPDATE "roles" SET permissions = permissions || '{"lead.read": true, "lead.manage": true}'::jsonb WHERE name = 'Project Manager';
