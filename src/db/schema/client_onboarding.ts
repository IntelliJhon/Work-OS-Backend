import { pgTable, timestamp, uuid, varchar, text, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const clientOnboarding = pgTable('client_onboarding', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  clientName: varchar('client_name', { length: 255 }).notNull(),
  contactPerson: varchar('contact_person', { length: 255 }),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  country: varchar('country', { length: 50 }).default('IN'),
  stage: varchar('stage', { length: 50 }).notNull().default('initiation'),
  status: varchar('status', { length: 50 }).notNull().default('in_progress'),
  assignedTo: varchar('assigned_to', { length: 255 }),
  targetDate: varchar('target_date', { length: 50 }),
  notes: text('notes'),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => {
  return {
    tenantIdx: index('idx_client_onboarding_tenant').on(table.tenantId),
    stageIdx: index('idx_client_onboarding_stage').on(table.stage),
  };
});
