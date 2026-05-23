import { pgTable, timestamp, uuid, varchar, jsonb, boolean, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  type: varchar('type', { length: 50 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  message: varchar('message', { length: 1000 }).notNull(),
  entityType: varchar('entity_type', { length: 50 }),
  entityId: uuid('entity_id'),
  priority: varchar('priority', { length: 50 }).default('info').notNull(),
  metadata: jsonb('metadata'),
  isRead: boolean('is_read').default(false).notNull(),
  readAt: timestamp('read_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => {
  return {
    tenantIdx: index('idx_notifications_tenant_id').on(table.tenantId),
    recipientIdx: index('idx_notifications_recipient_id').on(table.recipientUserId),
    readStatusIdx: index('idx_notifications_is_read').on(table.isRead),
    createdIdx: index('idx_notifications_created_at').on(table.createdAt),
  };
});
