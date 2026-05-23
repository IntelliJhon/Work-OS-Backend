import { pgTable, timestamp, uuid, varchar, unique, index, boolean } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { roles } from './roles';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  firstName: varchar('first_name', { length: 100 }).notNull(),
  lastName: varchar('last_name', { length: 100 }).notNull(),
  roleId: uuid('role_id').references(() => roles.id).notNull(),
  twoFaEnabled: boolean('two_fa_enabled').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => {
  return {
    emailTenantUnq: unique('users_tenant_email_unique').on(table.tenantId, table.email),
    roleIdx: index('idx_users_role_id').on(table.roleId),
  };
});
