import { pgTable, timestamp, uuid, varchar, text, integer, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const clientDocuments = pgTable('client_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  clientId: varchar('client_id', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  fileName: varchar('file_name', { length: 500 }).notNull(),
  fileUrl: text('file_url').notNull(),
  fileType: varchar('file_type', { length: 100 }).default('application/octet-stream'),
  fileSize: integer('file_size').default(0),
  uploaderName: varchar('uploader_name', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => {
  return {
    tenantClientIdx: index('idx_client_documents_tenant_client').on(table.tenantId, table.clientId),
  };
});
