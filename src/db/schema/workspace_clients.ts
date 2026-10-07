import { date, index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

// The Clients section of every workspace (migration 0042). Documents are uploads with entity_type 'CLIENT'.
// No RLS: every query filters by tenant_id.

export type ClientStatus = 'active' | 'on_hold' | 'former';
export type ClientActivityKind = 'note' | 'created' | 'updated' | 'file_added' | 'file_removed' | 'archived' | 'restored';

export const workspaceClients = pgTable('workspace_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  contactPerson: varchar('contact_person', { length: 120 }),
  phone: varchar('phone', { length: 20 }).notNull(),
  email: varchar('email', { length: 255 }),
  city: varchar('city', { length: 80 }),
  address: text('address'),
  gstNumber: varchar('gst_number', { length: 20 }),
  category: varchar('category', { length: 60 }),
  status: varchar('status', { length: 12 }).$type<ClientStatus>().default('active').notNull(),
  accountManagerId: uuid('account_manager_id').references(() => users.id, { onDelete: 'set null' }),
  clientSince: date('client_since'),
  notes: text('notes'),
  tags: text('tags').array().default([]).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index('idx_workspace_clients_tenant').on(table.tenantId),
}));

export const clientActivity = pgTable('client_activity', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  clientId: uuid('client_id').references(() => workspaceClients.id, { onDelete: 'cascade' }).notNull(),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  kind: varchar('kind', { length: 20 }).$type<ClientActivityKind>().notNull(),
  body: text('body'),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  clientIdx: index('idx_client_activity_client').on(table.clientId, table.createdAt),
}));
