import { pgTable, timestamp, uuid, varchar, index, pgEnum, integer, text } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { projects } from './projects';
import { activities } from './activities';

export const sprintStatusEnum = pgEnum('sprint_status', ['planning', 'active', 'closed', 'cancelled']);

export const sprints = pgTable('sprints', {
  id: uuid('id').primaryKey().defaultRandom(),
  activityId: uuid('activity_id').references(() => activities.id, { onDelete: 'cascade' }).notNull(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  status: sprintStatusEnum('status').notNull().default('planning'),
  startDate: timestamp('start_date'),
  endDate: timestamp('end_date'),
  cadenceType: varchar('cadence_type', { length: 50 }).$type<'WEEK' | 'MONTH' | 'CUSTOM'>(),
  cadenceInterval: integer('cadence_interval'),
  goal: text('goal'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => {
  return {
    activityIdx: index('idx_sprints_activity_id').on(table.activityId),
    projectIdx: index('idx_sprints_project_id').on(table.projectId),
  };
});
