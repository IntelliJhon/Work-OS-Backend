import { pgTable, timestamp, uuid, varchar, numeric, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { projects } from './projects';

export const projectActivities = pgTable('project_activities', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  parentId: uuid('parent_id'),
  title: varchar('title', { length: 255 }).notNull(),
  workHrs: numeric('work_hrs', { precision: 10, scale: 2 }).notNull().default('0'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => {
  return {
    projectIdx: index('idx_project_activities_project_id').on(table.projectId),
    tenantIdx: index('idx_project_activities_tenant_id').on(table.tenantId),
    parentIdx: index('idx_project_activities_parent_id').on(table.parentId),
  };
});
