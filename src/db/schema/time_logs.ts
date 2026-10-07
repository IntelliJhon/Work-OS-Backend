import { date, index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';
import { tasks } from './tasks';
import { projects } from './projects';
import { workReports } from './work_reports';

// Time worked on project tasks (migration 0043). Each entry is mirrored as a work report of that person.
// No RLS: every query filters by tenant_id.

export const taskTimeLogs = pgTable('task_time_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  workDate: date('work_date').notNull(),
  minutes: integer('minutes').notNull(),
  note: text('note').notNull(),
  workReportId: uuid('work_report_id').references(() => workReports.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userDayIdx: index('idx_task_time_logs_user_day').on(table.tenantId, table.userId, table.workDate),
  taskIdx: index('idx_task_time_logs_task').on(table.taskId),
}));

export const timeLogReminders = pgTable('time_log_reminders', {
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  workDate: date('work_date').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.workDate] }),
}));
