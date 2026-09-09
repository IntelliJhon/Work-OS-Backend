import { pgTable, timestamp, uuid, varchar, text, index } from 'drizzle-orm/pg-core';

export const clientEnquiries = pgTable('client_enquiries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: varchar('tenant_id', { length: 255 }).notNull(),
  clientName: varchar('client_name', { length: 255 }).notNull(),
  number: varchar('number', { length: 100 }).notNull(),
  email: varchar('email', { length: 255 }),
  remarks: text('remarks'),
  sourceSheetName: varchar('source_sheet_name', { length: 255 }),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    tenantIdx: index('idx_client_enquiries_tenant').on(table.tenantId),
  };
});
