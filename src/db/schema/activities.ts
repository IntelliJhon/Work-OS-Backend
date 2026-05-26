import { pgTable, timestamp, uuid, varchar, index, boolean } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { projects } from './projects';
import { phases } from './phases';

export const activities = pgTable('activities', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  phaseId: uuid('phase_id').references(() => phases.id, { onDelete: 'cascade' }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  isSprintRelevant: boolean('is_sprint_relevant').notNull().default(false),
  frequency: varchar('frequency', { length: 20 }),
  startDate: timestamp('start_date'),
  endDate: timestamp('end_date'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => {
  return {
    projectIdx: index('idx_activities_project_id').on(table.projectId),
    phaseIdx: index('idx_activities_phase_id').on(table.phaseId),
  };
});
