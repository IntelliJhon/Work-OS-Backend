-- Migration: 0042_workspace_clients
-- A Clients section for every workspace: the companies a workspace works for. Admins and Project Managers
-- (client.manage) add and edit clients, everyone with client.read sees them. Documents are in uploads
-- (entity_type 'CLIENT', entity_id = client); notes and changes are in client_activity.
-- (LeadsNDeals keeps its own CRM-linked Clients page and tables client_onboarding / client_notes / client_documents.)
-- No RLS: every query filters by tenant_id.
CREATE TABLE IF NOT EXISTS "workspace_clients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" varchar(160) NOT NULL,
  "contact_person" varchar(120),
  -- WhatsApp number, digits with country code
  "phone" varchar(20) NOT NULL,
  "email" varchar(255),
  "city" varchar(80),
  "address" text,
  "gst_number" varchar(20),
  "category" varchar(60),
  -- active | on_hold | former
  "status" varchar(12) DEFAULT 'active' NOT NULL,
  "account_manager_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "client_since" date,
  "notes" text,
  "tags" text[] DEFAULT '{}' NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_clients_tenant" ON "workspace_clients" ("tenant_id");--> statement-breakpoint
-- One live client per name in a workspace
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspace_clients_name" ON "workspace_clients" ("tenant_id", lower("name")) WHERE "archived_at" IS NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "client_activity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "client_id" uuid NOT NULL REFERENCES "workspace_clients"("id") ON DELETE CASCADE,
  "actor_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  -- note | created | updated | file_added | file_removed | archived | restored
  "kind" varchar(20) NOT NULL,
  -- The note's text, or a short description of the change
  "body" text,
  -- Changed fields { field: [before, after] }, or the file { uploadId, name }
  "meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_client_activity_client" ON "client_activity" ("client_id", "created_at");--> statement-breakpoint

-- Everyone sees clients; Admins (always) and Project Managers add and edit them
UPDATE "roles" SET permissions = permissions || '{"client.read": true}'::jsonb;--> statement-breakpoint
UPDATE "roles" SET permissions = permissions || '{"client.manage": true}'::jsonb WHERE name = 'Project Manager';
