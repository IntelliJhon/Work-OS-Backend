import { pgTable, timestamp, uuid, varchar, boolean, integer, index, pgEnum } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { projects } from './projects';

export const phaseStatusEnum = pgEnum('phase_status', ['pending', 'active', 'completed', 'blocked']);

export const phases = pgTable('phases', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 100 }).notNull(), 
  orderIndex: integer('order_index').notNull(),
  status: phaseStatusEnum('status').notNull().default('pending'),
  isLocked: boolean('is_locked').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => {
  return {
    projectIdx: index('idx_phases_project_id').on(table.projectId),
  };
});
