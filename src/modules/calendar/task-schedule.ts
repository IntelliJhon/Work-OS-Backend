import { env } from '../../config/env';

/**
 * Due times and reminders. A task's due date and time are stored as the assigner typed them
 * (customFields.dueDate 'YYYY-MM-DD', dueTime 'HH:mm', local to WORK_TIMEZONE), with
 * customFields.reminderMinutes = how long before the due time the assignee is reminded.
 * The exact moments (tasks.due_at / remind_at) are derived here, never taken from the client.
 */

/** Reminder choices offered to the assigner (minutes before the due time). */
export const REMINDER_CHOICES = [30, 60, 120, 180, 1440] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The UTC moment of a wall-clock date/time in a time zone (e.g. 2026-09-29 17:00 in Asia/Kolkata). */
export function zonedTimeToUtc(date: string, time: string, timeZone: string = env.WORK_TIMEZONE): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  // The zone's offset at that moment: format the UTC guess in the zone and compare
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(asUtc));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const zonedAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(asUtc - (zonedAsUtc - asUtc));
}

export interface TaskSchedule {
  dueAt: Date | null;
  remindAt: Date | null;
}

// When the chosen reminder time has already passed (work created or moved close to its due time),
// the reminder goes this long before the due time instead; if that has passed too, there is none.
export const LATE_REMINDER_MINUTES = 30;

/** Due and reminder moments from a task's custom fields. A reminder needs a due time. */
export function scheduleFromCustomFields(customFields: unknown, now: Date = new Date()): TaskSchedule {
  const cf = (customFields && typeof customFields === 'object' ? customFields : {}) as Record<string, unknown>;
  const dueDate = typeof cf.dueDate === 'string' && DATE_RE.test(cf.dueDate) ? cf.dueDate : null;
  const dueTime = typeof cf.dueTime === 'string' && TIME_RE.test(cf.dueTime) ? cf.dueTime : null;
  if (!dueDate || !dueTime) return { dueAt: null, remindAt: null };

  const dueAt = zonedTimeToUtc(dueDate, dueTime);
  const minutes = Number(cf.reminderMinutes);
  if (!(Number.isInteger(minutes) && minutes > 0 && minutes <= 7 * 24 * 60)) return { dueAt, remindAt: null };

  let remindAt: Date | null = new Date(dueAt.getTime() - minutes * 60_000);
  if (remindAt <= now) {
    const late = new Date(dueAt.getTime() - Math.min(minutes, LATE_REMINDER_MINUTES) * 60_000);
    remindAt = late > now ? late : null;
  }
  return { dueAt, remindAt };
}

const sameMoment = (a: Date | null | undefined, b: Date | null | undefined) =>
  (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

const SCHEDULE_KEYS = ['dueDate', 'dueTime', 'reminderMinutes'] as const;
const scheduleChanged = (next: unknown, prev: unknown) => {
  const a = (next ?? {}) as Record<string, unknown>;
  const b = (prev ?? {}) as Record<string, unknown>;
  return SCHEDULE_KEYS.some((k) => a[k] !== b[k]);
};

/**
 * Schedule columns for a task update: recomputed only when the due date/time or the reminder choice
 * changes (so an unrelated edit never moves or re-sends a reminder), and the reminder is sent again when
 * its moment or the assignee changes. Client-sent values for these columns are dropped.
 */
export function scheduleForUpdate(
  updates: Record<string, any>,
  oldTask: { customFields: unknown; assigneeId: string | null; remindAt: Date | null },
  now: Date = new Date(),
): Record<string, any> {
  const { dueAt: _dueAt, remindAt: _remindAt, reminderSentAt: _sent, ...rest } = updates;
  if (rest.customFields === undefined && rest.assigneeId === undefined) return rest;

  const fieldsChanged = rest.customFields !== undefined && scheduleChanged(rest.customFields, oldTask.customFields);
  const assigneeChanged = rest.assigneeId !== undefined && rest.assigneeId !== oldTask.assigneeId;
  if (!fieldsChanged && !assigneeChanged) return rest;

  // A new assignee gets the reminder by the same rule, from now on
  const schedule = scheduleFromCustomFields(rest.customFields ?? oldTask.customFields, now);
  const next: Record<string, any> = { ...rest, ...schedule };
  if (assigneeChanged || !sameMoment(schedule.remindAt, oldTask.remindAt)) next.reminderSentAt = null;
  return next;
}

/** "Tue, 29 Sep, 5:00 pm" (or just the date) from the stored local date/time. */
export function formatDueLabel(customFields: unknown): string | null {
  const cf = (customFields && typeof customFields === 'object' ? customFields : {}) as Record<string, unknown>;
  const dueDate = typeof cf.dueDate === 'string' && DATE_RE.test(cf.dueDate) ? cf.dueDate : null;
  if (!dueDate) return null;
  const dueTime = typeof cf.dueTime === 'string' && TIME_RE.test(cf.dueTime) ? cf.dueTime : null;
  const [y, mo, d] = dueDate.split('-').map(Number);
  const [h, mi] = (dueTime || '00:00').split(':').map(Number);
  const when = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const date = when.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  if (!dueTime) return date;
  return `${date}, ${when.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}`;
}
