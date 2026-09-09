import { pgTable, timestamp, uuid, varchar, text, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const workReports = pgTable('employee_work_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  employeeId: varchar('employee_id', { length: 255 }).notNull(),
  authorId: varchar('author_id', { length: 255 }).notNull(),
  authorName: varchar('author_name', { length: 255 }),
  authorEmail: varchar('author_email', { length: 255 }),
  title: varchar('title', { length: 255 }),
  reportText: text('report_text').notNull(),
  documentUrl: text('document_url'),
  documentName: varchar('document_name', { length: 255 }),
  fileType: varchar('file_type', { length: 100 }),
  fileSize: varchar('file_size', { length: 50 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => {
  return {
    tenantIdx: index('idx_work_reports_tenant').on(table.tenantId),
    employeeIdx: index('idx_work_reports_employee').on(table.employeeId),
  };
});
