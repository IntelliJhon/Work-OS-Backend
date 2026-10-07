import { pgTable, timestamp, uuid, varchar, text, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';
import { workspaceClients } from './workspace_clients';

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  pmId: uuid('pm_id').references(() => users.id, { onDelete: 'set null' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  overview: text('overview'),
  scopes: text('scopes'),
  clientName: varchar('client_name', { length: 255 }),
  // The client from the Clients section; NULL for the workspace's own "Company Projects" (migration 0043)
  clientId: uuid('client_id').references(() => workspaceClients.id, { onDelete: 'set null' }),
  status: varchar('status', { length: 50 }).notNull().default('active'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => {
  return {
    pmIdx: index('idx_projects_pm_id').on(table.pmId),
  };
});
