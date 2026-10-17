import { index, integer, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

// Access keys for the Work OS MCP server (migration 0045). Only the key's SHA-256 hash is stored.
export const mcpKeys = pgTable('mcp_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 80 }).notNull(),
  keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
  prefix: varchar('prefix', { length: 16 }).notNull(),
  sections: jsonb('sections').$type<string[]>().default([]).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  useCount: integer('use_count').default(0).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index('idx_mcp_keys_tenant').on(table.tenantId),
}));
