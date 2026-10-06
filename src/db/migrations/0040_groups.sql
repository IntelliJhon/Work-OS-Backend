-- Migration: 0040_groups
-- Company group chats (like WhatsApp groups): an Admin or Project Manager creates a group and adds members, who
-- message each other with text, @mentions and files. Files are in uploads (entity_type 'GROUP', entity_id = group).
-- No RLS: every query filters by tenant_id and checks membership.
CREATE TABLE IF NOT EXISTS "chat_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" varchar(80) NOT NULL,
  "description" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "archived_at" timestamp with time zone,
  -- Last message time, to sort the group list
  "last_message_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_groups_tenant" ON "chat_groups" ("tenant_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "chat_group_members" (
  "group_id" uuid NOT NULL REFERENCES "chat_groups"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- admin (manages members and settings) | member
  "role" varchar(10) DEFAULT 'member' NOT NULL,
  "added_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Messages after this are unread
  "last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("group_id", "user_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_group_members_user" ON "chat_group_members" ("tenant_id", "user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "chat_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "group_id" uuid NOT NULL REFERENCES "chat_groups"("id") ON DELETE CASCADE,
  "sender_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "body" text,
  -- People @mentioned (user ids)
  "mentions" uuid[] DEFAULT '{}' NOT NULL,
  -- [{ uploadId, name, mimeType, size }]
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_messages_group_time" ON "chat_messages" ("group_id", "created_at");--> statement-breakpoint

-- Project Managers can create groups (Admins always can)
UPDATE "roles" SET permissions = permissions || '{"groups.create": true}'::jsonb WHERE name = 'Project Manager';
