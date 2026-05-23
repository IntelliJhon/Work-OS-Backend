import { pgTable, timestamp, uuid, varchar, integer } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const uploads = pgTable('uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  uploaderUserId: uuid('uploader_user_id').references(() => users.id, { onDelete: 'set null' }),
  entityType: varchar('entity_type', { length: 50 }).notNull(), // TASK, GATE, PROJECT, PHASE, SPRINT
  entityId: uuid('entity_id').notNull(),
  originalName: varchar('original_name', { length: 500 }).notNull(),
  mimeType: varchar('mime_type', { length: 100 }).notNull(),
  size: integer('size').notNull(),
  storageKey: varchar('storage_key', { length: 500 }).notNull(),
  publicUrl: varchar('public_url', { length: 1000 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
