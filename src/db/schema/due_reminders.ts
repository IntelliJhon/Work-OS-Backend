import { index, integer, numeric, pgTable, smallint, text, timestamp, uuid, date, varchar } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

// Reminders for bills, renewals… (migration 0038). One row per occurrence; repeating ones share series_id.
// Days are local to WORK_TIMEZONE. No RLS: every query filters by tenant_id.

export type ReminderRepeat = 'once' | 'monthly' | 'yearly' | 'custom';
export type ReminderStatus = 'active' | 'done' | 'cancelled';

export const dueReminders = pgTable('due_reminders', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  seriesId: uuid('series_id').notNull(),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  title: varchar('title', { length: 200 }).notNull(),
  notes: text('notes'),
  category: varchar('category', { length: 20 }).default('bill').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }),
  repeat: varchar('repeat', { length: 10 }).$type<ReminderRepeat>().notNull(),
  everyN: smallint('every_n'),
  everyUnit: varchar('every_unit', { length: 10 }),
  anchorDate: date('anchor_date', { mode: 'string' }).notNull(),
  dueDate: date('due_date', { mode: 'string' }).notNull(),
  status: varchar('status', { length: 10 }).$type<ReminderStatus>().default('active').notNull(),
  nextNotifyAt: timestamp('next_notify_at', { withTimezone: true }),
  lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
  notifyCount: integer('notify_count').default(0).notNull(),
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  completedBy: uuid('completed_by').references(() => users.id, { onDelete: 'set null' }),
  report: text('report'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  notifyIdx: index('idx_due_reminders_notify').on(table.status, table.nextNotifyAt),
  tenantDueIdx: index('idx_due_reminders_tenant_due').on(table.tenantId, table.dueDate),
  seriesIdx: index('idx_due_reminders_series').on(table.tenantId, table.seriesId),
}));
