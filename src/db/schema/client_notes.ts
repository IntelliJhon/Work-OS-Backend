import { pgTable, timestamp, uuid, varchar, text, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const clientNotes = pgTable('client_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  clientId: varchar('client_id', { length: 255 }).notNull(),
  comment: text('comment').notNull().default(''),
  authorName: varchar('author_name', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => {
  return {
    tenantClientIdx: index('idx_client_notes_tenant_client').on(table.tenantId, table.clientId),
  };
});
