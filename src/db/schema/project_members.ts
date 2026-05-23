import { pgTable, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { projects } from './projects';
import { users } from './users';
import { roles } from './roles';

export const projectMembers = pgTable('project_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  roleId: uuid('role_id').references(() => roles.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => {
  return {
    projUserIdx: uniqueIndex('idx_project_members_proj_user').on(table.projectId, table.userId),
  };
});
