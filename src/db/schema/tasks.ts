import { jsonb, pgTable, timestamp, uuid, varchar, text, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { stories } from './stories';
import { sprints } from './sprints';
import { users } from './users';
import { projects } from './projects';

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  storyId: uuid('story_id').references(() => stories.id, { onDelete: 'cascade' }).notNull(),
  sprintId: uuid('sprint_id').references(() => sprints.id, { onDelete: 'set null' }),
  assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  status: varchar('status', { length: 50 }).notNull().default('todo'),
  customFields: jsonb('custom_fields').default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => {
  return {
    projectIdx: index('idx_tasks_project_id').on(table.projectId),
    storyIdx: index('idx_tasks_story_id').on(table.storyId),
    sprintIdx: index('idx_tasks_sprint_id').on(table.sprintId),
    assigneeIdx: index('idx_tasks_assignee_id').on(table.assigneeId),
  };
});
