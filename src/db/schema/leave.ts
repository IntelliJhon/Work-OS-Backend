import { index, pgTable, real, text, timestamp, uuid, date, varchar } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

// Leave requests (migration 0036). Days are local to WORK_TIMEZONE. No RLS: every query filters by tenant_id.

export type LeaveStatus = 'pending_manager' | 'pending_admin' | 'approved' | 'rejected' | 'cancelled';

export const leaveRequests = pgTable('leave_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  fromDay: date('from_day', { mode: 'string' }).notNull(),
  toDay: date('to_day', { mode: 'string' }).notNull(),
  // first | second (a single day only); null = full days
  halfDay: varchar('half_day', { length: 10 }),
  reason: text('reason').notNull(),
  status: varchar('status', { length: 20 }).$type<LeaveStatus>().notNull(),
  // Working days asked for (0.5 for a half day)
  days: real('days').notNull(),
  // Who decides the first step: the person the applicant reports to; null = any Project Manager
  managerId: uuid('manager_id').references(() => users.id, { onDelete: 'set null' }),
  managerBy: uuid('manager_by').references(() => users.id, { onDelete: 'set null' }),
  managerAt: timestamp('manager_at', { withTimezone: true }),
  managerComment: text('manager_comment'),
  adminBy: uuid('admin_by').references(() => users.id, { onDelete: 'set null' }),
  adminAt: timestamp('admin_at', { withTimezone: true }),
  adminComment: text('admin_comment'),
  // Moved to the Admins because the manager didn't act in time
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantStatusIdx: index('idx_leave_requests_tenant_status').on(table.tenantId, table.status),
  tenantUserIdx: index('idx_leave_requests_tenant_user').on(table.tenantId, table.userId),
}));
