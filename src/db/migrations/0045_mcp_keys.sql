-- Migration: 0045_mcp_keys
-- Access keys for the Work OS MCP server (n8n, Claude Desktop, ChatGPT…). A key reads one workspace's data only,
-- read-only, and only the sections it was given. Only a SHA-256 hash of the key is stored; the key is shown once.
CREATE TABLE IF NOT EXISTS "mcp_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" varchar(80) NOT NULL,
  "key_hash" varchar(64) NOT NULL UNIQUE,
  -- First characters of the key, to recognise it in the list
  "prefix" varchar(16) NOT NULL,
  -- Sections it may read, e.g. ["tasks","attendance"]
  "sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "last_used_at" timestamp with time zone,
  "use_count" integer DEFAULT 0 NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_keys_tenant" ON "mcp_keys" ("tenant_id");
