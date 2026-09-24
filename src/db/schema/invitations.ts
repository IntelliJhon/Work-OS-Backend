import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { roles } from './roles';

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  roleId: uuid('role_id').references(() => roles.id).notNull(),
  token: varchar('token', { length: 255 }).notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  acceptedAt: timestamp('accepted_at'),
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // Optional WhatsApp number set by the inviting admin; copied to the user on accept
  phone: varchar('phone', { length: 20 }),
});
