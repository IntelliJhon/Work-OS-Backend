import { boolean, date, doublePrecision, index, pgTable, primaryKey, real, smallint, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';
import { leaveRequests } from './leave';

// Attendance (migration 0035). All days and times are local to WORK_TIMEZONE. No RLS: every query filters by
// tenant_id from the signed-in user.

/** Per-workspace rules. A workspace without a row uses the defaults below. */
export const attendanceSettings = pgTable('attendance_settings', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').default(true).notNull(),
  // First check-in before this time is Present + Early; up to lateAfter Present; after it Late
  earlyBefore: varchar('early_before', { length: 5 }).default('09:30').notNull(),
  lateAfter: varchar('late_after', { length: 5 }).default('09:35').notNull(),
  // Logins before this time don't count as check-in
  checkInFrom: varchar('check_in_from', { length: 5 }).default('07:00').notNull(),
  // No check-in by this time = Absent; a first check-in after it is Absent too
  absentAfter: varchar('absent_after', { length: 5 }).default('12:00').notNull(),
  // ISO weekdays that are working days (1 = Monday … 7 = Sunday)
  workingDays: smallint('working_days').array().default([1, 2, 3, 4, 5, 6]).notNull(),
  // Days before this are never counted as absent (attendance didn't exist yet)
  startedOn: date('started_on', { mode: 'string' }).defaultNow().notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** One row per person per day: a check-in, a leave day, or an admin's entry. Absent days without a row are implied. */
export const attendanceRecords = pgTable('attendance_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  // present | late | absent | leave
  status: varchar('status', { length: 20 }).notNull(),
  early: boolean('early').default(false).notNull(),
  checkInAt: timestamp('check_in_at', { withTimezone: true }),
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),
  accuracyM: real('accuracy_m'),
  // ok | denied | unavailable (null for entries made by an admin)
  locationStatus: varchar('location_status', { length: 20 }),
  // Place name of the location, looked up after the check-in (NULL = not yet, '' = none found; migration 0044)
  locationName: varchar('location_name', { length: 200 }),
  note: text('note'),
  // Half a day of leave (first | second); the day's check-in is kept
  leaveHalf: varchar('leave_half', { length: 10 }),
  // Set when the leave came from an approved request (removed again if it is cancelled)
  leaveRequestId: uuid('leave_request_id').references(() => leaveRequests.id, { onDelete: 'set null' }),
  correctedBy: uuid('corrected_by').references(() => users.id, { onDelete: 'set null' }),
  correctedAt: timestamp('corrected_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userDay: unique('attendance_records_tenant_user_day_unique').on(table.tenantId, table.userId, table.day),
  tenantDayIdx: index('idx_attendance_records_tenant_day').on(table.tenantId, table.day),
}));

export const attendanceHolidays = pgTable('attendance_holidays', {
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.tenantId, table.day] }),
}));
