import { pgTable, timestamp, uuid, varchar, index, pgEnum, integer } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { projects } from './projects';
import { phases } from './phases';

export const sprintStatusEnum = pgEnum('sprint_status', ['planning', 'active', 'closed', 'cancelled']);

export const sprints = pgTable('sprints', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  phaseId: uuid('phase_id').references(() => phases.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  status: sprintStatusEnum('status').notNull().default('planning'),
  startDate: timestamp('start_date'),
  endDate: timestamp('end_date'),
  cadenceType: varchar('cadence_type', { length: 50 }).$type<'WEEK' | 'MONTH' | 'CUSTOM'>(),
  cadenceInterval: integer('cadence_interval'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => {
  return {
    projectIdx: index('idx_sprints_project_id').on(table.projectId),
    phaseIdx: index('idx_sprints_phase_id').on(table.phaseId),
  };
});
